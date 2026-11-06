//! Native SSH channel forwarding. Host identity must be pinned before authentication.
use dbstudio_protocol::{ConnectionConfig, DriverError, DriverResult, SecretMap};
use crate::network::{option, port, timeout};
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest,Sha256};
use std::{io::{Read,Write},net::{TcpListener,TcpStream,ToSocketAddrs},sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},thread,time::{Duration,Instant}};

pub struct SshTunnel { pub port:u16, stop:Arc<AtomicBool>, worker:Option<thread::JoinHandle<()>> }
impl Drop for SshTunnel {fn drop(&mut self){self.stop.store(true,Ordering::Relaxed);if let Some(worker)=self.worker.take(){let _=worker.join();}}}
fn failed()->DriverError{DriverError::new("connection_failed","SSH隧道连接失败")}

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
                let mut up=vec![];let mut down=vec![];let mut buffer=[0;16384];
                while !done.load(Ordering::Relaxed){
                    match local.read(&mut buffer){Ok(0)=>break,Ok(n)=>up.extend_from_slice(&buffer[..n]),Err(e)if e.kind()==std::io::ErrorKind::WouldBlock=>{},Err(_)=>break}
                    if !up.is_empty(){match channel.write(&up){Ok(n)=>{up.drain(..n);},Err(e)if e.kind()==std::io::ErrorKind::WouldBlock=>{},Err(_)=>break}}
                    match channel.read(&mut buffer){Ok(0)=>{if channel.eof(){break;}},Ok(n)=>down.extend_from_slice(&buffer[..n]),Err(e)if e.kind()==std::io::ErrorKind::WouldBlock=>{},Err(_)=>break}
                    if !down.is_empty(){match local.write(&down){Ok(n)=>{down.drain(..n);},Err(e)if e.kind()==std::io::ErrorKind::WouldBlock=>{},Err(_)=>break}}
                    if up.len()>1024*1024||down.len()>1024*1024{break;}thread::sleep(Duration::from_millis(2));
                }
                let _=channel.close();
            }));},
            Err(e)if e.kind()==std::io::ErrorKind::WouldBlock=>thread::sleep(Duration::from_millis(10)),Err(_)=>break
        }}
        for worker in workers {let _=worker.join();}
    });
    Ok(Some(SshTunnel{port:local_port,stop,worker:Some(worker)}))
}
