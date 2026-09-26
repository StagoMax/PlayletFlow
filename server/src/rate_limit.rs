use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const WINDOW: Duration = Duration::from_secs(60);
const PER_CLIENT_LIMIT: u32 = 5;
const INSTANCE_LIMIT: u32 = 60;

#[derive(Default)]
pub struct RateLimiter {
    inner: Mutex<WindowCounts>,
}

#[derive(Default)]
struct WindowCounts {
    clients: HashMap<String, (Instant, u32)>,
    instance: Option<(Instant, u32)>,
}

impl RateLimiter {
    pub fn check(&self, client: &str) -> bool {
        let now = Instant::now();
        let mut counts = self.inner.lock().expect("rate limiter lock");
        let instance = counts.instance.get_or_insert((now, 0));
        if now.duration_since(instance.0) >= WINDOW {
            *instance = (now, 0);
            counts.clients.retain(|_, (start, _)| now.duration_since(*start) < WINDOW);
        }
        if counts.instance.as_ref().is_some_and(|(_, count)| *count >= INSTANCE_LIMIT) {
            return false;
        }
        let client_count = counts.clients.entry(client.to_owned()).or_insert((now, 0));
        if now.duration_since(client_count.0) >= WINDOW {
            *client_count = (now, 0);
        }
        if client_count.1 >= PER_CLIENT_LIMIT {
            return false;
        }
        client_count.1 += 1;
        counts.instance.as_mut().expect("instance count").1 += 1;
        true
    }
}
