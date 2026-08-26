use tauri::{State, WebviewWindow};
use zeroize::Zeroize;

const MAX_SECRET_BYTES: usize = 2 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialKey {
    RefreshToken,
    DeviceCredential,
    QueueEncryptionKey,
    RemoteMcpConnector,
}

impl CredentialKey {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "refresh_token" => Ok(Self::RefreshToken),
            "device_credential" => Ok(Self::DeviceCredential),
            "queue_encryption_key" => Ok(Self::QueueEncryptionKey),
            "remote_mcp_connector" => Ok(Self::RemoteMcpConnector),
            _ => Err("unsupported credential key".to_owned()),
        }
    }

    fn target(self) -> &'static str {
        match self {
            Self::RefreshToken => "AliasMode/refresh-token",
            Self::DeviceCredential => "AliasMode/device-credential",
            Self::QueueEncryptionKey => "AliasMode/queue-encryption-key",
            Self::RemoteMcpConnector => "AliasMode/remote-mcp-connector",
        }
    }
}

pub struct CredentialOrigin(pub String);

pub(crate) fn store_refresh_token(mut secret: String) -> Result<(), String> {
    let result = if secret.len() > MAX_SECRET_BYTES {
        Err("credential secret is too large".to_owned())
    } else {
        write_secret(CredentialKey::RefreshToken, secret.as_bytes())
    };
    secret.zeroize();
    result
}

pub(crate) fn delete_cloud_credential(value: &str) -> Result<(), String> {
    let key = CredentialKey::parse(value)?;
    match key {
        CredentialKey::RefreshToken | CredentialKey::DeviceCredential => delete_secret(key),
        _ => Err("unsupported Cloud session credential".to_owned()),
    }
}

fn authorize(window: &WebviewWindow, state: &CredentialOrigin) -> Result<(), String> {
    if window.label() != "main" {
        return Err("credential bridge is available only to the main window".to_owned());
    }
    let origin = window
        .url()
        .map_err(|_| "credential bridge could not verify the window origin".to_owned())?
        .origin()
        .ascii_serialization();
    if origin != state.0 {
        return Err("credential bridge rejected the window origin".to_owned());
    }
    Ok(())
}

#[tauri::command]
pub fn credential_get(
    window: WebviewWindow,
    state: State<'_, CredentialOrigin>,
    key: String,
) -> Result<Option<String>, String> {
    authorize(&window, &state)?;
    read_secret(CredentialKey::parse(&key)?)
}

#[tauri::command]
pub fn credential_set(
    window: WebviewWindow,
    state: State<'_, CredentialOrigin>,
    key: String,
    mut secret: String,
) -> Result<(), String> {
    let result = (|| {
        authorize(&window, &state)?;
        if secret.len() > MAX_SECRET_BYTES {
            return Err("credential secret is too large".to_owned());
        }
        write_secret(CredentialKey::parse(&key)?, secret.as_bytes())
    })();
    secret.zeroize();
    result
}

#[tauri::command]
pub fn credential_delete(
    window: WebviewWindow,
    state: State<'_, CredentialOrigin>,
    key: String,
) -> Result<(), String> {
    authorize(&window, &state)?;
    delete_secret(CredentialKey::parse(&key)?)
}

#[cfg(windows)]
fn read_secret(key: CredentialKey) -> Result<Option<String>, String> {
    use std::{ffi::c_void, ptr, slice};
    use windows::{
        core::PCWSTR,
        Win32::Security::Credentials::{CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC},
    };

    let target: Vec<u16> = key.target().encode_utf16().chain(Some(0)).collect();
    let mut credential: *mut CREDENTIALW = ptr::null_mut();
    let result = unsafe {
        CredReadW(
            PCWSTR(target.as_ptr()),
            CRED_TYPE_GENERIC,
            None,
            &mut credential,
        )
    };
    if let Err(error) = result {
        if error.code().0 as u32 == 0x8007_0490 {
            return Ok(None);
        }
        return Err(
            "Windows Credential Manager could not read the requested credential".to_owned(),
        );
    }
    if credential.is_null() {
        return Ok(None);
    }

    let bytes = unsafe {
        let value = &*credential;
        slice::from_raw_parts(value.CredentialBlob, value.CredentialBlobSize as usize).to_vec()
    };
    unsafe { CredFree(credential.cast::<c_void>()) };
    match String::from_utf8(bytes) {
        Ok(secret) => Ok(Some(secret)),
        Err(error) => {
            let mut bytes = error.into_bytes();
            bytes.zeroize();
            Err("Windows Credential Manager returned an invalid AliasMode credential".to_owned())
        }
    }
}

#[cfg(windows)]
fn write_secret(key: CredentialKey, bytes: &[u8]) -> Result<(), String> {
    use windows::{
        core::PWSTR,
        Win32::Security::Credentials::{
            CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
        },
    };

    let mut target: Vec<u16> = key.target().encode_utf16().chain(Some(0)).collect();
    let mut blob = bytes.to_vec();
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target.as_mut_ptr()),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        ..Default::default()
    };
    let result = unsafe { CredWriteW(&credential, 0) }.map_err(|_| {
        "Windows Credential Manager could not store the requested credential".to_owned()
    });
    blob.zeroize();
    result
}

#[cfg(windows)]
fn delete_secret(key: CredentialKey) -> Result<(), String> {
    use windows::{
        core::PCWSTR,
        Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC},
    };

    let target: Vec<u16> = key.target().encode_utf16().chain(Some(0)).collect();
    match unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) } {
        Ok(()) => Ok(()),
        Err(error) if error.code().0 as u32 == 0x8007_0490 => Ok(()),
        Err(_) => {
            Err("Windows Credential Manager could not delete the requested credential".to_owned())
        }
    }
}

#[cfg(not(windows))]
fn read_secret(_key: CredentialKey) -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(not(windows))]
fn write_secret(_key: CredentialKey, _bytes: &[u8]) -> Result<(), String> {
    Err("Windows Credential Manager is unavailable on this platform".to_owned())
}

#[cfg(not(windows))]
fn delete_secret(_key: CredentialKey) -> Result<(), String> {
    Err("Windows Credential Manager is unavailable on this platform".to_owned())
}

#[cfg(test)]
mod tests {
    use super::{delete_cloud_credential, CredentialKey, MAX_SECRET_BYTES};

    #[test]
    fn maps_only_fixed_credential_keys() {
        assert_eq!(
            CredentialKey::parse("refresh_token").unwrap().target(),
            "AliasMode/refresh-token"
        );
        assert_eq!(
            CredentialKey::parse("device_credential").unwrap().target(),
            "AliasMode/device-credential"
        );
        assert_eq!(
            CredentialKey::parse("queue_encryption_key")
                .unwrap()
                .target(),
            "AliasMode/queue-encryption-key"
        );
        assert_eq!(
            CredentialKey::parse("remote_mcp_connector")
                .unwrap()
                .target(),
            "AliasMode/remote-mcp-connector"
        );
        assert!(CredentialKey::parse("access_token").is_err());
        assert!(CredentialKey::parse("AliasMode/arbitrary").is_err());
        assert!(CredentialKey::parse("*").is_err());
        assert!(delete_cloud_credential("remote_mcp_connector").is_err());
    }

    #[test]
    fn keeps_application_secret_limit_below_wincred_limit() {
        assert_eq!(MAX_SECRET_BYTES, 2 * 1024);
    }
}
