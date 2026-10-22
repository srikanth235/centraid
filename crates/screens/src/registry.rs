//! Which screens exist. A screen is registered under the name its
//! [`wire::Route`] carries; an app lane adds its screens here (or builds its
//! own [`Registry`] and merges), and the shell lane builds the standard one.

use centraid_api_proto::core_v1 as wire;

use crate::screen::Screen;

/// Makes a screen from the route that names it, or declines.
pub type Factory = Box<dyn Fn(&wire::Route) -> Option<Box<dyn Screen>> + Send + Sync>;

/// The screens a runtime can open.
#[derive(Default)]
pub struct Registry {
    screens: Vec<(&'static str, Factory)>,
}

impl Registry {
    /// Register `factory` under `name`. A name registered twice is a bug in
    /// the composing code, not a runtime choice.
    ///
    /// # Panics
    /// When `name` is already registered.
    #[must_use]
    pub fn with(
        mut self,
        name: &'static str,
        factory: impl Fn(&wire::Route) -> Option<Box<dyn Screen>> + Send + Sync + 'static,
    ) -> Self {
        assert!(
            !self.screens.iter().any(|(taken, _)| *taken == name),
            "screen `{name}` is registered twice"
        );
        self.screens.push((name, Box::new(factory)));
        self
    }

    pub(crate) fn build(&self, route: &wire::Route) -> Option<Box<dyn Screen>> {
        let (_, factory) = self.screens.iter().find(|(name, _)| *name == route.screen)?;
        factory(route)
    }
}
