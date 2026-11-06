//! Explicit native TLS policy. Never silently downgrade require/verify modes.
use dbstudio_protocol::{ConnectionConfig, DriverError, DriverResult};
use crate::network::option;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum TlsMode { Disable, Prefer, Require, VerifyCa, VerifyFull }
pub fn mode(config:&ConnectionConfig, pg:bool)->DriverResult<TlsMode>{
    match option(config,"sslmode",if pg {"prefer"}else{"disable"}).as_str(){
        "disable"=>Ok(TlsMode::Disable), "require"=>Ok(TlsMode::Require),
        "verify-ca"=>Ok(TlsMode::VerifyCa),"verify-full"=>Ok(TlsMode::VerifyFull),
        "prefer" if pg=>Ok(TlsMode::Prefer),
        "allow"=>Err(DriverError::unsupported("Rust驱动暂不支持allow模式，请选择prefer/require/verify-full或disable")),
        _=>Err(DriverError::invalid("TLS模式无效"))
    }
}
pub fn connector(config:&ConnectionConfig, mode:TlsMode)->DriverResult<native_tls::TlsConnector>{
    let mut builder=native_tls::TlsConnector::builder();
    builder.min_protocol_version(Some(native_tls::Protocol::Tlsv12));
    builder.danger_accept_invalid_certs(mode==TlsMode::Require||mode==TlsMode::Prefer);
    builder.danger_accept_invalid_hostnames(mode==TlsMode::Require||mode==TlsMode::Prefer||mode==TlsMode::VerifyCa);
    let path=option(config,"sslrootcert","");
    if !path.is_empty(){
        let info=std::fs::metadata(&path).map_err(|_|DriverError::new("connection_failed","无法读取TLS CA文件"))?;
        if !info.is_file()||info.len()>1024*1024{return Err(DriverError::invalid("TLS CA必须是最多1MiB的普通文件"));}
        let bytes=std::fs::read(path).map_err(|_|DriverError::new("connection_failed","无法读取TLS CA文件"))?;
        let cert=native_tls::Certificate::from_pem(&bytes).map_err(|_|DriverError::new("connection_failed","TLS CA证书无效"))?;
        builder.add_root_certificate(cert);
    }
    builder.build().map_err(|_|DriverError::new("connection_failed","TLS初始化失败"))
}
