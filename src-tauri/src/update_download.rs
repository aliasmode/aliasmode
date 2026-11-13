//! Downloads the update package over slow or unstable links.
//!
//! The download has no total time limit. It fails only when no bytes arrive for the stall
//! time, and then it starts again. When the server supports ranges, a new attempt asks only
//! for the missing bytes. The caller verifies the signature of the complete bytes.

use reqwest::{
    header::{ACCEPT, CONTENT_RANGE, RANGE},
    Client, StatusCode,
};
use std::time::Duration;
use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadFailure {
    /// No bytes arrived for the stall time.
    Stalled,
    /// The connection failed or closed early, or the server refused the request.
    Interrupted,
}

#[derive(Debug, PartialEq, Eq)]
pub struct DownloadError {
    pub failure: DownloadFailure,
    pub detail: String,
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{:?}: {}", self.failure, self.detail)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadEvent {
    Progress {
        downloaded: u64,
        total: Option<u64>,
    },
    /// An attempt failed and a new one starts after a short wait.
    Retrying,
}

pub struct DownloadPolicy {
    /// The longest time without new bytes.
    pub stall: Duration,
    /// The wait before each retry in a row that received no bytes. Its length is the
    /// number of such retries; an attempt that receives bytes starts the count again.
    pub retry_delays: &'static [Duration],
}

pub const UPDATE_DOWNLOAD_POLICY: DownloadPolicy = DownloadPolicy {
    stall: Duration::from_secs(60),
    retry_delays: &[
        Duration::from_secs(5),
        Duration::from_secs(15),
        Duration::from_secs(30),
        Duration::from_secs(60),
    ],
};

fn error(failure: DownloadFailure, detail: impl std::fmt::Display) -> DownloadError {
    DownloadError {
        failure,
        detail: detail.to_string(),
    }
}

/// Reads `bytes <start>-<end>/<size>` and returns the start and the size.
fn parse_content_range(value: &str) -> Option<(u64, u64)> {
    let (range, size) = value.strip_prefix("bytes ")?.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let (start, end, size) = (
        start.parse::<u64>().ok()?,
        end.parse::<u64>().ok()?,
        size.parse::<u64>().ok()?,
    );
    (start <= end && end < size).then_some((start, size))
}

struct State {
    bytes: Vec<u8>,
    total: Option<u64>,
    received: u64,
}

impl State {
    fn restart(&mut self) {
        self.bytes.clear();
        self.total = None;
    }
}

async fn attempt(
    client: &Client,
    url: &Url,
    stall: Duration,
    state: &mut State,
    on_event: &mut impl FnMut(DownloadEvent),
) -> Result<(), DownloadError> {
    let offset = state.bytes.len() as u64;
    let mut request = client
        .get(url.clone())
        .header(ACCEPT, "application/octet-stream");
    if offset > 0 {
        request = request.header(RANGE, format!("bytes={offset}-"));
    }
    let mut response = match tokio::time::timeout(stall, request.send()).await {
        Err(_) => return Err(error(DownloadFailure::Stalled, "no response")),
        Ok(Err(cause)) => return Err(error(DownloadFailure::Interrupted, cause)),
        Ok(Ok(response)) => response,
    };
    match response.status() {
        StatusCode::OK => {
            // A full answer: the server ignored the range or this is the first attempt.
            state.restart();
            state.total = response.content_length();
        }
        StatusCode::PARTIAL_CONTENT if offset > 0 => {
            let range = response
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .and_then(parse_content_range);
            match range {
                Some((start, size))
                    if start == offset && state.total.is_none_or(|total| total == size) =>
                {
                    state.total = Some(size);
                }
                _ => {
                    state.restart();
                    return Err(error(
                        DownloadFailure::Interrupted,
                        "the server resumed at a different position",
                    ));
                }
            }
        }
        status => {
            return Err(error(
                DownloadFailure::Interrupted,
                format!("the server returned {status}"),
            ))
        }
    }
    on_event(DownloadEvent::Progress {
        downloaded: state.bytes.len() as u64,
        total: state.total,
    });
    loop {
        match tokio::time::timeout(stall, response.chunk()).await {
            Err(_) => return Err(error(DownloadFailure::Stalled, "no data arrived")),
            Ok(Err(cause)) => return Err(error(DownloadFailure::Interrupted, cause)),
            Ok(Ok(None)) => break,
            Ok(Ok(Some(chunk))) => {
                state.received += chunk.len() as u64;
                state.bytes.extend_from_slice(&chunk);
                if state
                    .total
                    .is_some_and(|total| state.bytes.len() as u64 > total)
                {
                    state.restart();
                    return Err(error(
                        DownloadFailure::Interrupted,
                        "the server sent more bytes than it announced",
                    ));
                }
                on_event(DownloadEvent::Progress {
                    downloaded: state.bytes.len() as u64,
                    total: state.total,
                });
            }
        }
    }
    match state.total {
        Some(total) if (state.bytes.len() as u64) < total => Err(error(
            DownloadFailure::Interrupted,
            "the connection closed early",
        )),
        _ => Ok(()),
    }
}

pub async fn download(
    client: &Client,
    url: &Url,
    policy: &DownloadPolicy,
    mut on_event: impl FnMut(DownloadEvent),
) -> Result<Vec<u8>, DownloadError> {
    let mut state = State {
        bytes: Vec::new(),
        total: None,
        received: 0,
    };
    let mut retries_without_bytes = 0;
    loop {
        let received_before = state.received;
        let failure = match attempt(client, url, policy.stall, &mut state, &mut on_event).await {
            Ok(()) => return Ok(state.bytes),
            Err(failure) => failure,
        };
        if state.received > received_before {
            retries_without_bytes = 0;
        }
        let Some(delay) = policy.retry_delays.get(retries_without_bytes) else {
            return Err(failure);
        };
        retries_without_bytes += 1;
        eprintln!("AliasMode update download attempt failed, retrying: {failure}");
        on_event(DownloadEvent::Retrying);
        tokio::time::sleep(*delay).await;
    }
}

#[cfg(test)]
mod tests {
    use super::{download, parse_content_range, DownloadEvent, DownloadFailure, DownloadPolicy};
    use reqwest::Client;
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        sync::{Arc, Mutex},
        thread,
        time::Duration,
    };
    use url::Url;

    const STALL: Duration = Duration::from_millis(300);
    const NO_RETRY: DownloadPolicy = DownloadPolicy {
        stall: STALL,
        retry_delays: &[],
    };
    const RETRY: DownloadPolicy = DownloadPolicy {
        stall: STALL,
        retry_delays: &[Duration::from_millis(10), Duration::from_millis(10)],
    };

    /// What one connection does with the bytes after the requested offset.
    #[derive(Clone, Copy)]
    enum Reply {
        /// Sends this many bytes, then stops sending without closing.
        Pause(usize),
        /// Sends this many bytes, then closes the connection.
        Close(usize),
        /// Sends everything.
        Rest,
        /// Answers with this status and no body.
        Status(u16),
    }

    struct Server {
        url: Url,
        /// The `Range` header of each request, if any.
        ranges: Arc<Mutex<Vec<Option<String>>>>,
    }

    fn payload() -> Vec<u8> {
        (0..200_000_u32).map(|value| (value % 251) as u8).collect()
    }

    fn read_request(stream: &mut TcpStream) -> String {
        let mut request = Vec::new();
        let mut byte = [0_u8; 1];
        while !request.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap_or(0) == 1 {
            request.push(byte[0]);
        }
        String::from_utf8_lossy(&request).into_owned()
    }

    fn range_offset(range: Option<&str>) -> Option<usize> {
        range?
            .strip_prefix("bytes=")?
            .strip_suffix('-')?
            .parse()
            .ok()
    }

    /// Serves `body` once per reply. `honor_range` false acts as a server without ranges.
    fn answer(
        mut stream: TcpStream,
        body: &[u8],
        range: Option<&str>,
        reply: Reply,
        honor_range: bool,
    ) {
        if let Reply::Status(status) = reply {
            let _ = write!(
                stream,
                "HTTP/1.1 {status} Test\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
            );
            return;
        }
        let offset = range_offset(range).filter(|_| honor_range).unwrap_or(0);
        let rest = &body[offset..];
        let head = if offset > 0 {
            format!(
                "HTTP/1.1 206 Partial Content\r\ncontent-length: {}\r\ncontent-range: bytes {offset}-{}/{}\r\nconnection: close\r\n\r\n",
                rest.len(),
                body.len() - 1,
                body.len()
            )
        } else {
            format!(
                "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                rest.len()
            )
        };
        let _ = stream.write_all(head.as_bytes());
        match reply {
            Reply::Pause(count) => {
                let _ = stream.write_all(&rest[..count]);
                let _ = stream.flush();
                // Hold the connection open with no data, longer than the stall time.
                thread::sleep(STALL * 4);
            }
            Reply::Close(count) => {
                let _ = stream.write_all(&rest[..count]);
            }
            Reply::Rest | Reply::Status(_) => {
                let _ = stream.write_all(rest);
            }
        }
    }

    fn serve(body: Vec<u8>, replies: Vec<Reply>, honor_range: bool) -> Server {
        let body = Arc::new(body);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!(
            "http://{}/update.bin",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let ranges = Arc::new(Mutex::new(Vec::new()));
        let seen = ranges.clone();
        thread::spawn(move || {
            let mut replies = replies.into_iter();
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let request = read_request(&mut stream);
                let range = request
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("range: ")
                            .or(line.strip_prefix("Range: "))
                    })
                    .map(str::to_owned);
                seen.lock().unwrap().push(range.clone());
                let reply = replies.next().unwrap_or(Reply::Rest);
                let body = body.clone();
                // Each connection runs alone, so a held connection never delays the next one.
                thread::spawn(move || answer(stream, &body, range.as_deref(), reply, honor_range));
            }
        });
        Server { url, ranges }
    }

    fn run(
        server: &Server,
        policy: &DownloadPolicy,
    ) -> (Result<Vec<u8>, DownloadFailure>, Vec<DownloadEvent>) {
        let client = Client::builder().no_proxy().build().unwrap();
        let mut events = Vec::new();
        let result =
            tauri::async_runtime::block_on(download(&client, &server.url, policy, |event| {
                events.push(event)
            }));
        (result.map_err(|error| error.failure), events)
    }

    #[test]
    fn reads_only_valid_content_ranges() {
        assert_eq!(parse_content_range("bytes 100-199/200"), Some((100, 200)));
        assert_eq!(parse_content_range("bytes 0-0/1"), Some((0, 1)));
        for invalid in [
            "bytes 100-99/200",
            "bytes 100-200/200",
            "bytes */200",
            "items 0-1/2",
            "bytes 0-1",
        ] {
            assert_eq!(parse_content_range(invalid), None, "{invalid}");
        }
    }

    #[test]
    fn a_stall_without_retries_fails_like_the_old_single_request() {
        let server = serve(payload(), vec![Reply::Pause(50_000)], true);
        let (result, _) = run(&server, &NO_RETRY);
        assert_eq!(result, Err(DownloadFailure::Stalled));
    }

    #[test]
    fn resumes_after_a_stall_from_the_received_byte() {
        let body = payload();
        let server = serve(body.clone(), vec![Reply::Pause(50_000), Reply::Rest], true);
        let (result, events) = run(&server, &RETRY);
        assert_eq!(result.unwrap(), body);
        assert_eq!(
            *server.ranges.lock().unwrap(),
            [None, Some("bytes=50000-".to_owned())]
        );
        assert!(events.contains(&DownloadEvent::Retrying));
        assert_eq!(
            events.last(),
            Some(&DownloadEvent::Progress {
                downloaded: body.len() as u64,
                total: Some(body.len() as u64)
            })
        );
    }

    #[test]
    fn resumes_after_the_connection_closes_early() {
        let body = payload();
        let server = serve(
            body.clone(),
            vec![Reply::Close(70_000), Reply::Close(30_000), Reply::Rest],
            true,
        );
        let (result, _) = run(&server, &RETRY);
        assert_eq!(result.unwrap(), body);
        assert_eq!(
            *server.ranges.lock().unwrap(),
            [
                None,
                Some("bytes=70000-".to_owned()),
                Some("bytes=100000-".to_owned())
            ]
        );
    }

    #[test]
    fn starts_again_from_zero_when_the_server_ignores_the_range() {
        let body = payload();
        let server = serve(body.clone(), vec![Reply::Close(70_000), Reply::Rest], false);
        let (result, events) = run(&server, &RETRY);
        assert_eq!(result.unwrap(), body);
        assert!(events.contains(&DownloadEvent::Progress {
            downloaded: 0,
            total: Some(body.len() as u64)
        }));
    }

    #[test]
    fn retries_that_receive_bytes_do_not_use_up_the_retry_limit() {
        let body = payload();
        let replies = (0..6).map(|_| Reply::Close(20_000)).collect();
        let server = serve(body.clone(), replies, true);
        let (result, _) = run(&server, &RETRY);
        assert_eq!(result.unwrap(), body);
        assert_eq!(server.ranges.lock().unwrap().len(), 7);
    }

    #[test]
    fn gives_up_after_the_retries_without_bytes() {
        let server = serve(payload(), vec![Reply::Status(503); 5], true);
        let (result, events) = run(&server, &RETRY);
        assert_eq!(result, Err(DownloadFailure::Interrupted));
        assert_eq!(
            server.ranges.lock().unwrap().len(),
            RETRY.retry_delays.len() + 1
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| **event == DownloadEvent::Retrying)
                .count(),
            2
        );
    }

    #[test]
    fn a_closed_port_is_an_interrupted_download() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!(
            "http://{}/update.bin",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        drop(listener);
        let server = Server {
            url,
            ranges: Arc::default(),
        };
        // Windows answers a closed port only after its SYN retries (about 2 s), so wait longer than that.
        let policy = DownloadPolicy {
            stall: Duration::from_secs(10),
            retry_delays: &[],
        };
        let (result, _) = run(&server, &policy);
        assert_eq!(result, Err(DownloadFailure::Interrupted));
    }
}
