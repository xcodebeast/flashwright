//! One bounded startup message on the guardian liveness socket's otherwise unused direction.

use std::ffi::OsString;
use std::io::{self, Write};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

use tokio::io::{AsyncRead, AsyncReadExt};

const MAXIMUM_DIRECTORY_BYTES: usize = 4096;

pub(crate) fn write_directory(writer: &mut impl Write, directory: &Path) -> io::Result<()> {
    let bytes = directory.as_os_str().as_bytes();
    validate_directory(bytes)?;
    writer.write_all(&(bytes.len() as u32).to_le_bytes())?;
    writer.write_all(bytes)
}

pub(crate) async fn read_directory(reader: &mut (impl AsyncRead + Unpin)) -> io::Result<PathBuf> {
    let length = reader.read_u32_le().await? as usize;
    if length == 0 || length > MAXIMUM_DIRECTORY_BYTES {
        return Err(invalid_directory());
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).await?;
    validate_directory(&bytes)?;
    Ok(PathBuf::from(OsString::from_vec(bytes)))
}

fn validate_directory(bytes: &[u8]) -> io::Result<()> {
    if bytes.is_empty()
        || bytes.len() > MAXIMUM_DIRECTORY_BYTES
        || bytes[0] != b'/'
        || bytes.contains(&0)
    {
        return Err(invalid_directory());
    }
    Ok(())
}

fn invalid_directory() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid guardian artifact directory",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn directory_announcement_preserves_unix_bytes_without_waiting_for_liveness_eof() {
        let directory = PathBuf::from(OsString::from_vec(b"/temporary/non-utf8-\xff".to_vec()));
        let mut encoded = Vec::new();
        write_directory(&mut encoded, &directory).unwrap();
        let (mut writer, mut reader) = tokio::io::duplex(8192);
        tokio::io::AsyncWriteExt::write_all(&mut writer, &encoded)
            .await
            .unwrap();
        let received = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            read_directory(&mut reader),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(received, directory);
        drop(writer);
    }

    #[tokio::test]
    async fn invalid_or_incomplete_announcements_fail_before_publication() {
        for bytes in [
            0_u32.to_le_bytes().to_vec(),
            4097_u32.to_le_bytes().to_vec(),
            [3_u32.to_le_bytes().as_slice(), b"rel"].concat(),
            [3_u32.to_le_bytes().as_slice(), b"/\0x"].concat(),
            [20_u32.to_le_bytes().as_slice(), b"/short"].concat(),
        ] {
            assert!(read_directory(&mut bytes.as_slice()).await.is_err());
        }
    }
}
