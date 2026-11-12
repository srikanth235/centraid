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

    /// Load the model at `path` with the adapter file at `adapter`, when there is one (#1188 G4).
    /// The default ignores the adapter, so an engine that has none is unchanged. An engine that
    /// reads adapters overrides this; a file that is not a valid adapter comes back as
    /// [`ModelError::Load`] and the host then loads the base alone.
    ///
    /// # Errors
    /// [`ModelError::Load`] when the base or the adapter would not load.
    fn load_with_adapter(
        &self,
        path: &Path,
        adapter: Option<&Path>,
    ) -> Result<Arc<dyn Model>, ModelError> {
        let _ = adapter;
        self.load(path)
    }
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
    /// The adapter the rule allowed for this model when it was loaded (whether or not the engine
    /// took it). A model loaded before its adapter arrived is not "ready" once the rule allows
    /// one: the next load replaces it.
    adapter: Option<PathBuf>,
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
        *locked(&self.loaded) = Some(Loaded {
            path: None,
            adapter: None,
            model,
        });
        *locked(&self.vision) = None;
    }

    /// The model, when one is loaded.
    #[must_use]
    pub fn model(&self) -> Option<Arc<dyn Model>> {
        locked(&self.loaded)
            .as_ref()
            .map(|loaded| Arc::clone(&loaded.model))
    }

    /// The file the loaded model was read from, when it was loaded from one.
    #[must_use]
    pub fn loaded_path(&self) -> Option<PathBuf> {
        locked(&self.loaded)
            .as_ref()
            .and_then(|loaded| loaded.path.clone())
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
        let loaded = locked(&self.loaded).as_ref().is_some_and(|loaded| {
            loaded
                .path
                .as_deref()
                .is_none_or(|held| held == path && loaded.adapter == wanted_adapter(path))
        });
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
            .and_then(|loader| load_best(&*loader, path));
        let outcome = result.map(|model| {
            *locked(&self.loaded) = Some(Loaded {
                path: Some(path.to_path_buf()),
                adapter: wanted_adapter(path),
                model,
            });
            *locked(&self.vision) = None;
        });
        self.loading.store(false, Ordering::SeqCst);
        outcome.map(|()| self.status(path))
    }
}

/// The adapter file the rule allows for the model at `path`: it is in the directory, of the
/// recorded size, made for this base and this build.
fn wanted_adapter(path: &Path) -> Option<PathBuf> {
    let record = crate::record::record();
    let (dir, file) = path
        .parent()
        .zip(path.file_name().and_then(|n| n.to_str()))?;
    crate::adapter::resolve(&record, dir, file)
        .used()
        .then_some(())
        .and(record.adapter.as_ref())
        .map(|adapter| dir.join(adapter.local_name()))
}

/// Load `path` with the adapter the record's rule allows for it, or alone: an adapter that will
/// not load is not an error a member acts on, so the base is loaded without it and the turn runs
/// stock.
fn load_best(loader: &dyn ModelLoader, path: &Path) -> Result<Arc<dyn Model>, ModelError> {
    match wanted_adapter(path) {
        Some(adapter) => loader
            .load_with_adapter(path, Some(&adapter))
            .or_else(|_| loader.load(path)),
        None => loader.load(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::ScriptedModel;
    use std::sync::Mutex;

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

    /// An engine that reads adapters: it records what it was given and refuses a bad adapter.
    struct Adapting {
        seen: Mutex<Vec<Option<PathBuf>>>,
        bad: bool,
    }

    impl ModelLoader for Adapting {
        fn load(&self, _: &Path) -> Result<Arc<dyn Model>, ModelError> {
            self.seen.lock().unwrap().push(None);
            Ok(Arc::new(ScriptedModel::new(Vec::<String>::new())))
        }

        fn load_with_adapter(
            &self,
            path: &Path,
            adapter: Option<&Path>,
        ) -> Result<Arc<dyn Model>, ModelError> {
            if let Some(adapter) = adapter {
                self.seen.lock().unwrap().push(Some(adapter.to_path_buf()));
                if self.bad {
                    return Err(ModelError::Load("not an adapter".to_owned()));
                }
                return Ok(Arc::new(ScriptedModel::new(Vec::<String>::new())));
            }
            self.load(path)
        }
    }

    /// A record whose base is `model.gguf` and whose adapter file (3 bytes) sits beside `base`.
    fn with_adapter_beside(base: &Path) -> (crate::record::Record, PathBuf) {
        let mut record = crate::record::record();
        record.current.file_name = "model.gguf".to_owned();
        let (tools, prompt) = crate::record::runtime_hashes(
            crate::native::prompt::ToolsMode::parse(&record.current.tools_mode).unwrap(),
        );
        let adapter = crate::record::Adapter {
            url: String::new(),
            file_name: "a.gguf".to_owned(),
            sha256: "ef".repeat(32),
            bytes: 3,
            base_sha256: record.current.sha256.clone(),
            tools_hash: tools,
            prompt_hash: prompt,
            score: None,
        };
        let file = base.parent().unwrap().join(adapter.local_name());
        std::fs::write(&file, b"abc").unwrap();
        record.adapter = Some(adapter);
        (record, file)
    }

    #[test]
    fn the_adapter_is_handed_to_the_engine_when_the_rule_allows_and_not_otherwise() {
        let base = scratch("adapter-ok", b"base");
        let (record, file) = with_adapter_beside(&base);
        let loader = Arc::new(Adapting {
            seen: Mutex::new(Vec::new()),
            bad: false,
        });
        let host = ModelHost::new();
        host.set_loader(loader.clone());
        crate::record::held_for(record.clone(), || host.load(&base).unwrap());
        assert_eq!(*loader.seen.lock().unwrap(), [Some(file.clone())]);
        // the file is gone: the base loads alone
        std::fs::remove_file(&file).unwrap();
        host.unload();
        crate::record::held_for(record, || host.load(&base).unwrap());
        assert_eq!(loader.seen.lock().unwrap().last(), Some(&None));
    }

    #[test]
    fn an_adapter_that_will_not_load_leaves_the_base_loaded_alone() {
        let base = scratch("adapter-bad", b"base");
        let (record, file) = with_adapter_beside(&base);
        let loader = Arc::new(Adapting {
            seen: Mutex::new(Vec::new()),
            bad: true,
        });
        let host = ModelHost::new();
        host.set_loader(loader.clone());
        let status = crate::record::held_for(record, || host.load(&base).unwrap());
        assert_eq!(status.state, ModelState::Ready);
        assert_eq!(*loader.seen.lock().unwrap(), [Some(file), None]);
    }

    #[test]
    fn a_model_loaded_before_its_adapter_arrived_is_loaded_again_with_it() {
        let base = scratch("adapter-late", b"base");
        let (record, file) = with_adapter_beside(&base);
        std::fs::remove_file(&file).unwrap();
        let loader = Arc::new(Adapting {
            seen: Mutex::new(Vec::new()),
            bad: false,
        });
        let host = ModelHost::new();
        host.set_loader(loader.clone());
        crate::record::held_for(record, || {
            host.load(&base).unwrap();
            assert_eq!(host.status(&base).state, ModelState::Ready);
            // the member fetched the adapter
            std::fs::write(&file, b"abc").unwrap();
            assert_eq!(host.status(&base).state, ModelState::Present);
            host.load(&base).unwrap();
            assert_eq!(host.status(&base).state, ModelState::Ready);
        });
        assert_eq!(
            *loader.seen.lock().unwrap(),
            [None, Some(file)],
            "the second load carried the adapter"
        );
    }

    /// A model whose generation blocks until released, so "a turn is running" is a fact the test
    /// holds with channels and no clock.
    struct Held {
        started: Mutex<std::sync::mpsc::Sender<()>>,
        release: Mutex<std::sync::mpsc::Receiver<()>>,
        generated: std::sync::atomic::AtomicUsize,
    }

    impl Model for Held {
        fn generate(
            &self,
            _: &crate::model::GenerateRequest<'_>,
            _: &mut dyn FnMut(&str) -> crate::model::Control,
        ) -> Result<crate::model::Generation, ModelError> {
            self.started.lock().unwrap().send(()).unwrap();
            let _ = self.release.lock().unwrap().recv();
            self.generated
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(crate::model::Generation {
                text: "done".to_owned(),
                finish: crate::model::Finish::Stop,
                prompt_tokens: 0,
                generated_tokens: 1,
            })
        }
    }

    #[test]
    fn an_adapter_landing_under_a_running_generation_changes_nothing_until_the_next_load() {
        let base = scratch("adapter-running", b"base");
        let (record, file) = with_adapter_beside(&base);
        std::fs::remove_file(&file).unwrap();
        let (started_tx, started) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let held = Arc::new(Held {
            started: Mutex::new(started_tx),
            release: Mutex::new(release_rx),
            generated: 0.into(),
        });
        struct Gate(Arc<Held>, Mutex<Vec<Option<PathBuf>>>);
        impl ModelLoader for Gate {
            fn load(&self, path: &Path) -> Result<Arc<dyn Model>, ModelError> {
                self.load_with_adapter(path, None)
            }
            fn load_with_adapter(
                &self,
                _: &Path,
                adapter: Option<&Path>,
            ) -> Result<Arc<dyn Model>, ModelError> {
                self.1.lock().unwrap().push(adapter.map(Path::to_path_buf));
                Ok(Arc::clone(&self.0) as Arc<dyn Model>)
            }
        }
        let loader = Arc::new(Gate(held.clone(), Mutex::new(Vec::new())));
        let host = Arc::new(ModelHost::new());
        host.set_loader(loader.clone());
        crate::record::held_for(record, || {
            host.load(&base).unwrap();
            let running = host.model().expect("loaded");
            let turn = std::thread::spawn(move || {
                let cancel = crate::model::Cancel::new();
                running.generate(
                    &crate::model::GenerateRequest {
                        prompt: "p",
                        grammar: None,
                        max_tokens: 1,
                        stop: &[],
                        temperature: 0.0,
                        cancel: &cancel,
                        images: &[],
                    },
                    &mut |_| crate::model::Control::Continue,
                )
            });
            started.recv().expect("the generation is running");
            // the adapter lands under it: nothing loads, the generation is untouched
            std::fs::write(&file, b"abc").unwrap();
            assert_eq!(loader.1.lock().unwrap().len(), 1, "no reload under a turn");
            assert_eq!(held.generated.load(std::sync::atomic::Ordering::SeqCst), 0);
            release.send(()).unwrap();
            let out = turn.join().unwrap().unwrap();
            assert_eq!(
                out.text, "done",
                "the turn finished on the model it began with"
            );
            assert_eq!(loader.1.lock().unwrap().len(), 1, "its end reloads nothing");
            // the next load carries the adapter, once
            host.load(&base).unwrap();
            assert_eq!(
                *loader.1.lock().unwrap(),
                [None, Some(file.clone())],
                "load_with_adapter ran once with Some"
            );
        });
    }
}
