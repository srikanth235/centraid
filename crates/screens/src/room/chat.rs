use super::screen::Registry;

#[must_use]
pub fn registry() -> Registry {
    Registry::new()
}
