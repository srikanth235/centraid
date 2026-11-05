//! A MODEL THAT SAYS WHAT IT WAS TOLD, for tests and for checking the rig: no weights, no network.

use std::sync::Mutex;

use centraid_assist::native::prompt::ToolsMode;

use crate::run::{StepOut, Stepper};

/// One message of the model's: a think stating nothing and one call, in the text form the runtime reads.
#[must_use]
pub fn message(tool: &str, params: &[(&str, &str)]) -> String {
    let mut text = format!("<think>\nintent: go\n</think>\n\n<tool_call>\n<function={tool}>\n");
    for (name, value) in params {
        text += &format!("<parameter={name}>\n{value}\n</parameter>\n");
    }
    text + "</function>\n</tool_call>"
}

/// Says its messages in order, one per step, across every session and sample it is asked for; when they run out it
/// repeats the last. Samples run one after another, so a script is the whole run's messages in sequence.
pub struct Scripted(Mutex<Vec<String>>);

impl Scripted {
    /// # Panics
    /// When `messages` is empty: a model that says nothing is no model.
    #[must_use]
    pub fn new(messages: Vec<String>) -> Self {
        assert!(!messages.is_empty(), "a script needs a message");
        Self(Mutex::new(messages))
    }
}

impl Stepper for Scripted {
    fn step(
        &self,
        _prompt: &str,
        _dates: Option<&str>,
        _tools: ToolsMode,
    ) -> Result<StepOut, String> {
        let mut said = self.0.lock().map_err(|e| e.to_string())?;
        let text = if said.len() > 1 {
            said.remove(0)
        } else {
            said[0].clone()
        };
        Ok(StepOut {
            text,
            think_cut: false,
        })
    }
}
