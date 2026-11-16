//! Native SSH channel forwarding. Host identity must be pinned before authentication.
use dbstudio_protocol::{ConnectionConfig, DriverError, DriverResult, SecretMap};
use crate::network::{option, port, timeout};
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest,Sha256};
use std::{io::{self,Read,Write},net::{Shutdown,TcpListener,TcpStream,ToSocketAddrs},sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},thread,time::{Duration,Instant}};

const CHUNK: usize = 16 * 1024;
const HIGH_WATER: usize = 1024 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(2);
const SHUTDOWN_FLUSH: Duration = Duration::from_secs(1);

pub struct SshTunnel { pub port:u16, stop:Arc<AtomicBool>, worker:Option<thread::JoinHandle<()>> }
impl Drop for SshTunnel {fn drop(&mut self){self.stop.store(true,Ordering::Relaxed);if let Some(worker)=self.worker.take(){let _=worker.join();}}}
fn failed()->DriverError{DriverError::new("connection_failed","SSH隧道连接失败")}

/// One end of a forwarded stream. Reads and writes are non-blocking; `WouldBlock`
/// means "not ready yet" and is never treated as EOF.
trait TunnelEnd {
    fn read_chunk(&mut self, out: &mut [u8]) -> io::Result<usize>;
    fn write_chunk(&mut self, data: &[u8]) -> io::Result<usize>;
    fn flush_chunk(&mut self) -> io::Result<()>;
    /// Half-close the outbound direction; reads on this end stay available.
    fn close_write(&mut self) -> io::Result<()>;
}
impl TunnelEnd for TcpStream {
    fn read_chunk(&mut self, out: &mut [u8]) -> io::Result<usize> { self.read(out) }
    fn write_chunk(&mut self, data: &[u8]) -> io::Result<usize> { self.write(data) }
    fn flush_chunk(&mut self) -> io::Result<()> { self.flush() }
    fn close_write(&mut self) -> io::Result<()> { self.shutdown(Shutdown::Write) }
}
impl TunnelEnd for ssh2::Channel {
    fn read_chunk(&mut self, out: &mut [u8]) -> io::Result<usize> { self.read(out) }
    fn write_chunk(&mut self, data: &[u8]) -> io::Result<usize> { self.write(data) }
    // `Channel::flush` is libssh2_channel_flush (drops unread inbound data), not an
    // outbound flush, so writes are only complete when `write_chunk` accepted them.
    fn flush_chunk(&mut self) -> io::Result<()> { Ok(()) }
    fn close_write(&mut self) -> io::Result<()> { self.send_eof().map_err(|_| io::Error::other("SSH 通道半关闭失败")) }
}

fn would_block(error: &io::Error) -> bool {
    matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut)
}

/// Forward bytes in both directions with backpressure and half-close handling.
///
/// A direction is only read while its bounded buffer is below the high-water
/// mark, so a slow peer stops the socket instead of growing memory without
/// bound. EOF stops only that reader: the opposite direction keeps flowing
/// until its peer closes too, and both buffers drain before the loop exits.
fn pump<L: TunnelEnd, C: TunnelEnd>(local: &mut L, channel: &mut C, done: &AtomicBool, idle_timeout: Duration) -> io::Result<()> {
    let mut up = Vec::new();   // local -> SSH
    let mut down = Vec::new(); // SSH -> local
    let (mut local_eof, mut channel_eof) = (false, false);
    let (mut up_closed, mut down_closed) = (false, false);
    let mut buffer = [0u8; CHUNK];
    let mut last_progress = Instant::now();
    loop {
        if done.load(Ordering::Relaxed) {
            // Tunnel teardown: give pending bytes a bounded chance to leave, never drop them silently.
            let deadline = Instant::now() + SHUTDOWN_FLUSH;
            while (!up.is_empty() || !down.is_empty()) && Instant::now() < deadline {
                if !up.is_empty() {
                    match channel.write_chunk(&up) {
                        Ok(0) => break,
                        Ok(n) => { up.drain(..n); },
                        Err(error) if would_block(&error) => {},
                        Err(_) => break,
                    }
                }
                if !down.is_empty() {
                    match local.write_chunk(&down) {
                        Ok(0) => break,
                        Ok(n) => { down.drain(..n); },
                        Err(error) if would_block(&error) => {},
                        Err(_) => break,
                    }
                }
                if !up.is_empty() || !down.is_empty() { thread::sleep(POLL_INTERVAL); }
            }
            let _ = channel.flush_chunk();
            let _ = local.flush_chunk();
            return Ok(());
        }
        let mut active = false;
        if !local_eof && up.len() < HIGH_WATER {
            match local.read_chunk(&mut buffer) {
                Ok(0) => { local_eof = true; active = true; },
                Ok(n) => { up.extend_from_slice(&buffer[..n]); active = true; },
                Err(error) if would_block(&error) => {},
                Err(error) => return Err(error),
            }
        }
        if !up.is_empty() {
            match channel.write_chunk(&up) {
                Ok(0) => return Err(io::Error::new(io::ErrorKind::WriteZero, "SSH 通道未接受转发数据")),
                Ok(n) => { up.drain(..n); active = true; },
                Err(error) if would_block(&error) => {},
                Err(error) => return Err(error),
            }
        } else if local_eof && !up_closed {
            channel.close_write()?;
            up_closed = true;
        }
        if !channel_eof && down.len() < HIGH_WATER {
            match channel.read_chunk(&mut buffer) {
                Ok(0) => { channel_eof = true; active = true; },
                Ok(n) => { down.extend_from_slice(&buffer[..n]); active = true; },
                Err(error) if would_block(&error) => {},
                Err(error) => return Err(error),
            }
        }
        if !down.is_empty() {
            match local.write_chunk(&down) {
                Ok(0) => return Err(io::Error::new(io::ErrorKind::WriteZero, "本地套接字未接受转发数据")),
                Ok(n) => { down.drain(..n); active = true; },
                Err(error) if would_block(&error) => {},
                Err(error) => return Err(error),
            }
        } else if channel_eof && !down_closed {
            local.close_write()?;
            down_closed = true;
        }
        if local_eof && channel_eof && up.is_empty() && down.is_empty() && up_closed && down_closed {
            channel.flush_chunk()?;
            local.flush_chunk()?;
            return Ok(());
        }
        if active { last_progress = Instant::now(); }
        else if (!up.is_empty() || !down.is_empty()) && last_progress.elapsed() >= idle_timeout {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "SSH 转发等待对端可写超时"));
        }
        if !active { thread::sleep(POLL_INTERVAL); }
    }
}

pub fn open(config:&ConnectionConfig,secrets:&SecretMap,target:&str,target_port:u16)->DriverResult<Option<SshTunnel>>{
    let host=option(config,"sshHost","");if host.is_empty(){return Ok(None);}
    let pinned=option(config,"sshHostKeySha256","");
    if pinned.is_empty(){return Err(DriverError::new("ssh_host_key_required","SSH连接需要显式SHA256主机指纹"));}
    let address=(host.as_str(),port(config,"sshPort",22)?).to_socket_addrs().map_err(|_|failed())?.next().ok_or_else(failed)?;
    let tcp=TcpStream::connect_timeout(&address,timeout()).map_err(|_|failed())?;
    tcp.set_read_timeout(Some(timeout())).map_err(|_|failed())?;tcp.set_write_timeout(Some(timeout())).map_err(|_|failed())?;
    let nonblocking_socket=tcp.try_clone().map_err(|_|failed())?;
    let mut session=ssh2::Session::new().map_err(|_|failed())?;session.set_tcp_stream(tcp);session.set_timeout(10_000);session.handshake().map_err(|_|failed())?;
    let (key,_)=session.host_key().ok_or_else(failed)?;
    let fingerprint=format!("SHA256:{}",STANDARD.encode(Sha256::digest(key)).trim_end_matches('='));
    if fingerprint!=pinned {return Err(DriverError::new("ssh_host_key_mismatch","SSH主机指纹不匹配"));}
    let user=option(config,"sshUser","");if user.is_empty(){return Err(DriverError::invalid("缺少SSH用户名"));}
    let key_file=option(config,"sshPrivateKey","");
    if !key_file.is_empty(){let pass=secrets.get("sshPassphrase").and_then(serde_json::Value::as_str);session.userauth_pubkey_file(&user,None,std::path::Path::new(&key_file),pass).map_err(|_|failed())?;}
    else {let password=secrets.get("sshPassword").and_then(serde_json::Value::as_str).ok_or_else(||DriverError::invalid("缺少SSH凭据"))?;session.userauth_password(&user,password).map_err(|_|failed())?;}
    if !session.authenticated(){return Err(failed());}
    nonblocking_socket.set_nonblocking(true).map_err(|_|failed())?;session.set_blocking(false);
    // libssh2 channel-open retries must retain their arguments until EAGAIN resolves.
    let open_lock=Arc::new(Mutex::new(()));
    let listener=TcpListener::bind(("127.0.0.1",0)).map_err(|_|failed())?;let local_port=listener.local_addr().map_err(|_|failed())?.port();listener.set_nonblocking(true).map_err(|_|failed())?;
    let stop=Arc::new(AtomicBool::new(false));let shutdown=stop.clone();let target=target.to_string();
    let worker=thread::spawn(move||{
        let mut workers:Vec<thread::JoinHandle<()>>=vec![];
        while !shutdown.load(Ordering::Relaxed){
            workers.retain(|h|!h.is_finished());
            if workers.len()>=8{thread::sleep(Duration::from_millis(10));continue;}
            match listener.accept(){
            Ok((mut local,_))=>{let session=session.clone();let target=target.clone();let done=shutdown.clone();let open_lock=open_lock.clone();workers.push(thread::spawn(move||{
                let deadline=Instant::now()+timeout();
                let open_guard=loop{match open_lock.try_lock(){Ok(guard)=>break guard,Err(std::sync::TryLockError::WouldBlock)=>{if done.load(Ordering::Relaxed)||Instant::now()>=deadline{return;}thread::sleep(Duration::from_millis(2));},Err(_)=>return}};
                let mut channel=loop{if done.load(Ordering::Relaxed)||Instant::now()>=deadline{return;}match session.channel_direct_tcpip(&target,target_port,None){Ok(channel)=>break channel,Err(e)if e.code()==ssh2::ErrorCode::Session(-37)=>thread::sleep(Duration::from_millis(2)),Err(_)=>return}};
                drop(open_guard);
                if local.set_nonblocking(true).is_err(){return;}
                let _=pump(&mut local,&mut channel,&done,timeout());
                let _=channel.close();
            }));},
            Err(e)if e.kind()==std::io::ErrorKind::WouldBlock=>thread::sleep(Duration::from_millis(10)),Err(_)=>break
        }}
        for worker in workers {let _=worker.join();}
    });
    Ok(Some(SshTunnel{port:local_port,stop,worker:Some(worker)}))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// In-memory peer: a finite read side, an accumulating write side and an
    /// optional write budget that simulates a slow consumer.
    struct MemoryEnd {
        input: Vec<u8>,
        position: usize,
        eof_when_drained: bool,
        output: Vec<u8>,
        write_limit: usize,
        block_writes: bool,
        closed: bool,
    }
    impl MemoryEnd {
        fn new(input: Vec<u8>, eof_when_drained: bool) -> Self {
            Self { input, position: 0, eof_when_drained, output: Vec::new(), write_limit: usize::MAX, block_writes: false, closed: false }
        }
    }
    impl TunnelEnd for MemoryEnd {
        fn read_chunk(&mut self, out: &mut [u8]) -> io::Result<usize> {
            if self.position < self.input.len() {
                let length = (self.input.len() - self.position).min(out.len());
                out[..length].copy_from_slice(&self.input[self.position..self.position + length]);
                self.position += length;
                Ok(length)
            } else if self.eof_when_drained { Ok(0) } else { Err(io::ErrorKind::WouldBlock.into()) }
        }
        fn write_chunk(&mut self, data: &[u8]) -> io::Result<usize> {
            if self.block_writes { return Err(io::ErrorKind::WouldBlock.into()); }
            let length = data.len().min(self.write_limit);
            self.output.extend_from_slice(&data[..length]);
            Ok(length)
        }
        fn flush_chunk(&mut self) -> io::Result<()> { Ok(()) }
        fn close_write(&mut self) -> io::Result<()> { self.closed = true; Ok(()) }
    }
    fn run(local: &mut MemoryEnd, channel: &mut MemoryEnd, idle: Duration) -> io::Result<()> {
        pump(local, channel, &AtomicBool::new(false), idle)
    }

    #[test]
    fn forwards_more_than_one_mebibyte_in_both_directions_without_truncation() {
        let up = (0..3 * 1024 * 1024).map(|index| (index % 251) as u8).collect::<Vec<_>>();
        let down = (0..2 * 1024 * 1024 + 7).map(|index| (index % 241) as u8).collect::<Vec<_>>();
        let mut local = MemoryEnd::new(up.clone(), true);
        let mut channel = MemoryEnd::new(down.clone(), true);
        local.write_limit = 32 * 1024;
        channel.write_limit = 64 * 1024;
        run(&mut local, &mut channel, Duration::from_secs(10)).unwrap();
        assert_eq!(channel.output, up);
        assert_eq!(local.output, down);
        assert!(local.closed && channel.closed, "both half-closes must be forwarded");
    }

    #[test]
    fn one_sided_eof_does_not_discard_bytes_still_buffered_for_the_other_direction() {
        let up = vec![9u8; 300 * 1024];
        let mut local = MemoryEnd::new(up.clone(), true);
        let mut channel = MemoryEnd::new(Vec::new(), true);
        channel.write_limit = 8 * 1024;
        run(&mut local, &mut channel, Duration::from_secs(10)).unwrap();
        assert_eq!(channel.output, up, "local EOF must not truncate the pending upload");
        assert!(channel.closed);
    }

    #[test]
    fn data_keeps_flowing_after_the_client_closed_its_write_side() {
        let down = vec![7u8; 512 * 1024];
        let mut local = MemoryEnd::new(Vec::new(), true);
        let mut channel = MemoryEnd::new(down.clone(), true);
        local.write_limit = 16 * 1024;
        run(&mut local, &mut channel, Duration::from_secs(10)).unwrap();
        assert_eq!(local.output, down, "channel data must still reach the half-closed client");
        assert!(local.closed);
    }

    #[test]
    fn a_peer_that_never_becomes_writable_times_out_instead_of_discarding_data() {
        let mut local = MemoryEnd::new(vec![1u8; 64 * 1024], false);
        let mut channel = MemoryEnd::new(Vec::new(), false);
        channel.block_writes = true;
        let started = Instant::now();
        let error = run(&mut local, &mut channel, Duration::from_millis(30)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() >= Duration::from_millis(30));
        assert!(channel.output.is_empty());
    }
}
