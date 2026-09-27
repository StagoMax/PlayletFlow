use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const WINDOW: Duration = Duration::from_secs(60);
const PER_CLIENT_LIMIT: u32 = 5;
const INSTANCE_LIMIT: u32 = 60;

pub struct RateLimiter {
    inner: Mutex<WindowCounts>,
    per_client_limit: u32,
    instance_limit: u32,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::with_limits(PER_CLIENT_LIMIT, INSTANCE_LIMIT)
    }
}

#[derive(Default)]
struct WindowCounts {
    clients: HashMap<String, (Instant, u32)>,
    instance: Option<(Instant, u32)>,
}

impl RateLimiter {
    pub fn with_limits(per_client_limit: u32, instance_limit: u32) -> Self {
        Self {
            inner: Mutex::new(WindowCounts::default()),
            per_client_limit,
            instance_limit,
        }
    }

    pub fn check(&self, client: &str) -> bool {
        let now = Instant::now();
        let mut counts = self.inner.lock().expect("rate limiter lock");
        let instance = counts.instance.get_or_insert((now, 0));
        if now.duration_since(instance.0) >= WINDOW {
            *instance = (now, 0);
            counts
                .clients
                .retain(|_, (start, _)| now.duration_since(*start) < WINDOW);
        }
        if counts
            .instance
            .as_ref()
            .is_some_and(|(_, count)| *count >= self.instance_limit)
        {
            return false;
        }
        let client_count = counts.clients.entry(client.to_owned()).or_insert((now, 0));
        if now.duration_since(client_count.0) >= WINDOW {
            *client_count = (now, 0);
        }
        if client_count.1 >= self.per_client_limit {
            return false;
        }
        client_count.1 += 1;
        counts.instance.as_mut().expect("instance count").1 += 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::RateLimiter;

    #[test]
    fn configurable_limits_preserve_default_and_bound_writes() {
        let default = RateLimiter::default();
        for _ in 0..5 {
            assert!(default.check("client"));
        }
        assert!(!default.check("client"));

        let workspace = RateLimiter::with_limits(2, 3);
        assert!(workspace.check("a"));
        assert!(workspace.check("a"));
        assert!(!workspace.check("a"));
        assert!(workspace.check("b"));
        assert!(!workspace.check("c"));
    }
}
