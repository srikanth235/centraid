// The Locker boundary, as a subpath (#996, ruling W6-D2).
//
// A subpath rather than the package root because the PHONE imports this. The
// root pulls the web shell's React surface with it, and the RN app needs
// exactly two things from here: the seat's AES-GCM envelope and the session
// that guards `K`. Everything in this directory is DOM-free and runs on
// whatever WebCrypto the seat has.
export * from "./locker-key-door.js";
export * from "./locker-kit-door.js";
export * from "./locker-secret.js";
export * from "./locker-unlock.js";
export * from "./wrapped-key-store.js";
