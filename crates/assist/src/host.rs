//! WHERE THE MODEL LIVES: one slot per process, filled from a file.
//!
//! A phone holds several vault handles and one model (a 0.8B Q4 file is half a
//! gigabyte of RAM once loaded), so the slot is a value a shell shares between
//! handles rather than a field of each. The shell owns the **download** — it is
//! the one place Centraid fetches anything — and hands the core a path; this is
//! what answers "is there a model at that path, and is it loaded".
//!
//! An engine registers a [`ModelLoader`]. A build with none reports
//! [`ModelState::NoEngine`] for a file that is there, which is a state a shell
//! can draw and the honest one: the bytes are present and nothing can read them.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::model::{Model, ModelError};

/// Opens a model file. The llama.cpp binding implements this.
pub trait ModelLoader: Send + Sync {
    /// Load the model at `path`.
    ///
    /// # Errors
    /// [`ModelError::Load`] when the file is not a model this engine reads.
    fn load(&self, path: &Path) -> Result<Arc<dyn Model>, ModelError>;
}

/// Where the model stands, for the shell's one decision: what to show.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelState {
    /// No file at the path (or an empty one): show the download step.
    Absent,
    /// The file is there and no engine is linked into this build.
    NoEngine,
    /// The file is there and not loaded.
    Present,
    /// A load is running.
    Loading,
    /// Loaded and answering.
    Ready,
}

/// [`ModelState`] and the file's size, which a shell compares with the size it
/// downloaded to know a transfer was whole.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelStatus {
    pub state: ModelState,
    pub bytes: u64,
}

/// Where the vision projector stands, for the shell's one decision about an
/// attached photo: draw the download step, load it, or go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VisionState {
    /// No file at the projector path (or an empty one): photos cannot be read
    /// until the shell has fetched it.
    Absent,
    /// The file is there and the loaded model does not carry it.
    Present,
    /// The loaded model carries it: a photo may be attached.
    Ready,
}

/// [`VisionState`] and the file's size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VisionStatus {
    pub state: VisionState,
    pub bytes: u64,
}

struct Loaded {
    /// `None` for a model installed directly (a test's fake), which answers for
    /// any path.
    path: Option<PathBuf>,
    model: Arc<dyn Model>,
}

/// The slot.
#[derive(Default)]
pub struct ModelHost {
    loader: Mutex<Option<Arc<dyn ModelLoader>>>,
    loaded: Mutex<Option<Loaded>>,
    loading: AtomicBool,
    /// The projector the loaded model was given, when it was given one.
    vision: Mutex<Option<PathBuf>>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl ModelHost {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register the engine that will open model files.
    pub fn set_loader(&self, loader: Arc<dyn ModelLoader>) {
        *locked(&self.loader) = Some(loader);
    }

    /// Put a model in the slot directly. For tests and for an engine that
    /// loads on its own schedule; it answers for any path.
    pub fn install(&self, model: Arc<dyn Model>) {
        *locked(&self.loaded) = Some(Loaded { path: None, model });
        *locked(&self.vision) = None;
    }

    /// The model, when one is loaded.
    #[must_use]
    pub fn model(&self) -> Option<Arc<dyn Model>> {
        locked(&self.loaded)
            .as_ref()
            .map(|loaded| Arc::clone(&loaded.model))
    }

    /// Free the model's memory. A shell does this under memory pressure; the
    /// next turn loads it again.
    pub fn unload(&self) {
        *locked(&self.loaded) = None;
        *locked(&self.vision) = None;
    }

    /// Where the projector at `projector` stands against the loaded model. A
    /// stat and a lookup: nothing is read.
    #[must_use]
    pub fn vision_status(&self, projector: &Path) -> VisionStatus {
        let bytes = std::fs::metadata(projector)
            .ok()
            .filter(std::fs::Metadata::is_file)
            .map_or(0, |meta| meta.len());
        let ready = locked(&self.loaded)
            .as_ref()
            .is_some_and(|loaded| loaded.model.has_vision())
            && locked(&self.vision)
                .as_deref()
                .is_none_or(|held| held == projector);
        let state = if ready {
            VisionState::Ready
        } else if bytes == 0 {
            VisionState::Absent
        } else {
            VisionState::Present
        };
        VisionStatus { state, bytes }
    }

    /// Give the loaded model the projector at `projector`, without reloading
    /// its weights. Blocks for as long as the engine takes.
    ///
    /// # Errors
    /// [`ModelError::Load`] when no model is loaded, there is no file, or the
    /// engine refuses it as a projector for this model.
    pub fn attach_vision(&self, projector: &Path) -> Result<VisionStatus, ModelError> {
        let status = self.vision_status(projector);
        match status.state {
            VisionState::Ready => return Ok(status),
            VisionState::Absent => {
                return Err(ModelError::Load(
                    "there is no projector file at that path".to_owned(),
                ));
            }
            VisionState::Present => {}
        }
        let model = self
            .model()
            .ok_or_else(|| ModelError::Load("load the model before its projector".to_owned()))?;
        model.attach_vision(projector)?;
        *locked(&self.vision) = Some(projector.to_path_buf());
        Ok(self.vision_status(projector))
    }

    /// Where the model at `path` stands.
    #[must_use]
    pub fn status(&self, path: &Path) -> ModelStatus {
        let bytes = std::fs::metadata(path)
            .ok()
            .filter(std::fs::Metadata::is_file)
            .map_or(0, |meta| meta.len());
        let loaded = locked(&self.loaded)
            .as_ref()
            .is_some_and(|loaded| loaded.path.as_deref().is_none_or(|held| held == path));
        let state = if loaded {
            ModelState::Ready
        } else if self.loading.load(Ordering::SeqCst) {
            ModelState::Loading
        } else if bytes == 0 {
            ModelState::Absent
        } else if locked(&self.loader).is_none() {
            ModelState::NoEngine
        } else {
            ModelState::Present
        };
        ModelStatus { state, bytes }
    }

    /// Load the model at `path`, replacing whatever was loaded. Blocks for as
    /// long as the engine takes; the shell calls it off its UI thread and draws
    /// the wait itself.
    ///
    /// # Errors
    /// [`ModelError::Load`] when there is no file, no engine, or the engine
    /// refuses the file.
    pub fn load(&self, path: &Path) -> Result<ModelStatus, ModelError> {
        let status = self.status(path);
        match status.state {
            ModelState::Absent => {
                return Err(ModelError::Load(
                    "there is no model file at that path".to_owned(),
                ));
            }
            ModelState::NoEngine => {
                return Err(ModelError::Load(
                    "this build has no engine to read a model with".to_owned(),
                ));
            }
            ModelState::Ready => return Ok(status),
            ModelState::Present | ModelState::Loading => {}
        }
        if self.loading.swap(true, Ordering::SeqCst) {
            return Err(ModelError::Load("a load is already running".to_owned()));
        }
        let loader = locked(&self.loader).clone();
        let result = loader
            .ok_or_else(|| {
                ModelError::Load("this build has no engine to read a model with".to_owned())
            })
            .and_then(|loader| loader.load(path));
        let outcome = result.map(|model| {
            *locked(&self.loaded) = Some(Loaded {
                path: Some(path.to_path_buf()),
                model,
            });
            *locked(&self.vision) = None;
        });
        self.loading.store(false, Ordering::SeqCst);
        outcome.map(|()| self.status(path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::ScriptedModel;

    struct Loader(Arc<dyn Model>);

    impl ModelLoader for Loader {
        fn load(&self, _: &Path) -> Result<Arc<dyn Model>, ModelError> {
            Ok(Arc::clone(&self.0))
        }
    }

    struct Refusing;

    impl ModelLoader for Refusing {
        fn load(&self, _: &Path) -> Result<Arc<dyn Model>, ModelError> {
            Err(ModelError::Load("not a GGUF file".to_owned()))
        }
    }

    fn scratch(name: &str, bytes: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "centraid-assist-host-{}-{name}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("model.gguf");
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn no_file_is_absent_and_an_empty_file_is_absent_too() {
        let host = ModelHost::new();
        let missing = std::env::temp_dir().join("centraid-assist-host-nowhere.gguf");
        assert_eq!(host.status(&missing).state, ModelState::Absent);
        assert_eq!(
            host.status(&scratch("empty", b"")).state,
            ModelState::Absent
        );
        assert!(host.load(&missing).is_err());
    }

    #[test]
    fn a_file_with_no_engine_is_no_engine_and_will_not_load() {
        let host = ModelHost::new();
        let path = scratch("noengine", b"bytes");
        assert_eq!(
            host.status(&path),
            ModelStatus {
                state: ModelState::NoEngine,
                bytes: 5
            }
        );
        assert!(matches!(host.load(&path), Err(ModelError::Load(_))));
    }

    #[test]
    fn a_file_with_an_engine_is_present_then_ready_after_a_load() {
        let host = ModelHost::new();
        host.set_loader(Arc::new(Loader(Arc::new(ScriptedModel::empty()))));
        let path = scratch("ready", b"bytes");
        assert_eq!(host.status(&path).state, ModelState::Present);
        assert!(host.model().is_none());
        assert_eq!(host.load(&path).unwrap().state, ModelState::Ready);
        assert!(host.model().is_some());
        // Ready answers for the path it loaded, not for another file.
        assert_eq!(
            host.status(&scratch("other", b"x")).state,
            ModelState::Present
        );
    }

    #[test]
    fn a_refused_load_leaves_the_slot_empty_and_is_not_stuck_loading() {
        let host = ModelHost::new();
        host.set_loader(Arc::new(Refusing));
        let path = scratch("refused", b"bytes");
        assert!(matches!(host.load(&path), Err(ModelError::Load(_))));
        assert_eq!(host.status(&path).state, ModelState::Present);
        assert!(host.model().is_none());
    }

    #[test]
    fn a_projector_is_absent_present_then_ready_and_never_reloads_the_model() {
        let host = ModelHost::new();
        let model = Arc::new(ScriptedModel::empty());
        host.set_loader(Arc::new(Loader(model.clone())));
        let weights = scratch("vision-weights", b"weights");
        let projector = scratch("vision-projector", b"projector");
        let nowhere = std::env::temp_dir().join("centraid-assist-host-no-projector.gguf");

        assert_eq!(host.vision_status(&nowhere).state, VisionState::Absent);
        assert_eq!(host.vision_status(&projector).state, VisionState::Present);
        assert_eq!(host.vision_status(&projector).bytes, 9);
        // Not before the model: a projector is the model's.
        assert!(matches!(
            host.attach_vision(&projector),
            Err(ModelError::Load(_))
        ));
        host.load(&weights).unwrap();
        assert!(matches!(
            host.attach_vision(&nowhere),
            Err(ModelError::Load(_))
        ));
        assert_eq!(
            host.attach_vision(&projector).unwrap().state,
            VisionState::Ready
        );
        assert!(model.has_vision());
        // The weights were not loaded again to give them eyes.
        assert_eq!(host.status(&weights).state, ModelState::Ready);
        // Another file is not the one the model carries.
        host.unload();
        assert_eq!(host.vision_status(&projector).state, VisionState::Present);
    }

    #[test]
    fn unload_frees_the_slot() {
        let host = ModelHost::new();
        host.install(Arc::new(ScriptedModel::empty()));
        assert_eq!(host.status(Path::new("anywhere")).state, ModelState::Ready);
        host.unload();
        assert!(host.model().is_none());
    }
}
