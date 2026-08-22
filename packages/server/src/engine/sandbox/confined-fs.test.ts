/*
 * The filesystem mirror the sandbox substitutes for `node:fs` (#842 W7.1).
 *
 * WHY THIS FILE EXISTS. `fs-guard.ts`, `confined-fs.ts` and
 * `confined-fs-promises.ts` are the whole of the filesystem confinement — the
 * code that decides whether a granted lane may read a path — and they were
 * exercised ONLY through worker threads, which V8 coverage does not
 * instrument. That is the worst possible combination: the most
 * security-critical modules in the sandbox were reading 0% covered, so nothing
 * about them was measured, and a refactor that quietly broke the confinement
 * would have registered as no change at all. `policy.test.ts` proves the
 * POLICY objects are right; this proves the ENFORCEMENT that reads them is.
 *
 * Every test below is a confinement claim, not a line-count exercise. The
 * arrangement is deliberate: a granted root with a real file in it, a sibling
 * directory that is NOT granted but shares a name prefix, and a symlink from
 * inside the root pointing out of it — the three shapes a path check gets
 * wrong.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import * as confinedPromises from "./confined-fs-promises.js";
import * as confined from "./confined-fs.js";
import { SandboxDeniedError } from "./denied.js";
import {
  confinedReadRoots,
  guardReadPath,
  setConfinedReadRoots,
} from "./fs-guard.js";

describe("sandbox filesystem confinement", () => {
  let base: string;
  /** The granted root. */
  let root: string;
  /** A sibling that SHARES A PREFIX with the root and is not granted. */
  let sibling: string;
  let insideFile: string;
  let outsideFile: string;
  /** A symlink that lives inside the root and points outside it. */
  let escapeLink: string;

  beforeAll(async () => {
    // `tempDir` rather than a raw `mkdtemp`: it registers the directory for the
    // suite-wide cleanup the test-kit owns, which is why the raw call is
    // restricted.
    base = await tempDir("centraid-confined-");
    root = path.join(base, "granted");
    sibling = path.join(base, "granted-evil");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(sibling, { recursive: true });
    insideFile = path.join(root, "readable.txt");
    outsideFile = path.join(sibling, "secret.txt");
    await fs.writeFile(insideFile, "inside");
    await fs.writeFile(outsideFile, "outside");
    escapeLink = path.join(root, "escape.txt");
    await fs.symlink(outsideFile, escapeLink);
  });

  describe(guardReadPath, () => {
    test("refuses everything while no root is granted", () => {
      setConfinedReadRoots([]);
      expect(confinedReadRoots()).toStrictEqual([]);
      // The empty-grant case is the one a bug is most likely to invert, because
      // "no roots" reads like "no restriction" if the check is written as a
      // negation. It must mean "nothing is readable".
      expect(() => guardReadPath("readFileSync", insideFile)).toThrow(
        SandboxDeniedError
      );
    });

    test("admits a path inside a granted root and returns it absolute", () => {
      setConfinedReadRoots([root]);
      expect(guardReadPath("readFileSync", insideFile)).toBe(insideFile);
      // Relative input resolves against cwd before the check, so a caller cannot
      // dodge confinement by passing a relative path.
      expect(
        guardReadPath("readFileSync", path.relative(process.cwd(), insideFile))
      ).toBe(insideFile);
    });

    test("refuses a sibling directory that merely shares the root's prefix", () => {
      setConfinedReadRoots([root]);
      // `/…/granted-evil` starts with `/…/granted`. A `startsWith` check admits
      // it; `path.relative` does not. This is the prefix bug the guard's own
      // comment names, pinned so it cannot come back.
      expect(() => guardReadPath("readFileSync", outsideFile)).toThrow(
        /refused|denied/iu
      );
    });

    test("refuses a symlink inside the root that points outside it", () => {
      setConfinedReadRoots([root]);
      // The link's own path is inside the root. Only realpath resolution catches
      // this, so a guard that checked the literal path would hand the handler
      // the file the link points at.
      expect(() => guardReadPath("readFileSync", escapeLink)).toThrow(
        SandboxDeniedError
      );
    });

    test("checks a missing file against its nearest existing ancestor", () => {
      setConfinedReadRoots([root]);
      // Inside the root: allowed, even though nothing is there yet.
      expect(guardReadPath("statSync", path.join(root, "a/b/c.txt"))).toBe(
        path.join(root, "a/b/c.txt")
      );
      // Outside it: still refused. Without the ancestor walk, a probe for a
      // non-existent path would skip the check entirely and leak existence.
      expect(() =>
        guardReadPath("statSync", path.join(sibling, "a/b/c.txt"))
      ).toThrow(SandboxDeniedError);
    });

    test("refuses a path argument that is not path-like", () => {
      setConfinedReadRoots([root]);
      for (const bad of [42, null, undefined, {}, Symbol("x")])
        expect(() => guardReadPath("readFileSync", bad)).toThrow(
          SandboxDeniedError
        );
    });

    test("accepts the URL and Buffer spellings node itself accepts", () => {
      setConfinedReadRoots([root]);
      expect(guardReadPath("readFileSync", Buffer.from(insideFile))).toBe(
        insideFile
      );
      expect(() =>
        guardReadPath("readFileSync", Buffer.from(outsideFile))
      ).toThrow(SandboxDeniedError);
      // `new URL("file://…")` is a first-class path argument to node's own fs.
      // If the guard did not understand it the coercion would return null and
      // every URL read would be refused — closed, but broken for a legitimate
      // caller — so the spelling is asserted in both directions.
      expect(guardReadPath("readFileSync", pathToFileURL(insideFile))).toBe(
        insideFile
      );
      expect(() =>
        guardReadPath("readFileSync", pathToFileURL(outsideFile))
      ).toThrow(SandboxDeniedError);
    });
  });

  describe("confined-fs — the sync mirror", () => {
    test("reads through every mirrored entry point inside the root", () => {
      setConfinedReadRoots([root]);
      expect(String(confined.readFileSync(insideFile))).toBe("inside");
      expect(confined.existsSync(insideFile)).toBe(true);
      expect(confined.statSync(insideFile)?.isFile()).toBe(true);
      expect(confined.lstatSync(insideFile)?.isFile()).toBe(true);
      expect(confined.readdirSync(root)).toContain("readable.txt");
      expect(confined.realpathSync(insideFile)).toBe(insideFile);
      const fd = confined.openSync(insideFile, "r") as number;
      expect(fd).toBeGreaterThan(0);
      confined.createReadStream(insideFile).close();
    });

    test("every mirrored read refuses a path outside the root", () => {
      setConfinedReadRoots([root]);
      expect(() => confined.readFileSync(outsideFile)).toThrow(
        SandboxDeniedError
      );
      expect(() => confined.statSync(outsideFile)).toThrow(SandboxDeniedError);
      expect(() => confined.lstatSync(outsideFile)).toThrow(SandboxDeniedError);
      expect(() => confined.readdirSync(sibling)).toThrow(SandboxDeniedError);
      expect(() => confined.realpathSync(outsideFile)).toThrow(
        SandboxDeniedError
      );
      expect(() => confined.openSync(outsideFile, "r")).toThrow(
        SandboxDeniedError
      );
      expect(() => confined.createReadStream(outsideFile)).toThrow(
        SandboxDeniedError
      );
    });

    test("openSync refuses every mode that can write, inside the root too", () => {
      setConfinedReadRoots([root]);
      // The lane is READ-confined, and `openSync` is the one read entry point
      // that its second argument can turn into a write. So the mode is checked
      // as well as the path: `w`, `a` and every `+` variant reach a write path
      // and must be refused even on a file this lane is allowed to read.
      for (const mode of ["w", "a", "w+", "r+", "a+", "wx", "as+"])
        expect(
          () => confined.openSync(insideFile, mode),
          `openSync(${mode}) must refuse`
        ).toThrow(SandboxDeniedError);
      expect(confined.openSync(insideFile, "r")).toBeGreaterThan(0);
    });

    test("existsSync REFUSES rather than answering false for an outside path", () => {
      setConfinedReadRoots([root]);
      // Answering `false` would be a side channel: a handler could map the disk
      // by probing. A refusal says "not your business", which is different.
      expect(() => confined.existsSync(outsideFile)).toThrow(
        SandboxDeniedError
      );
    });

    test("every write entry point refuses, inside the root included", () => {
      setConfinedReadRoots([root]);
      const target = path.join(root, "new.txt");
      const writers: ReadonlyArray<[string, () => unknown]> = [
        ["writeFileSync", () => confined.writeFileSync()],
        ["appendFileSync", () => confined.appendFileSync()],
        ["mkdirSync", () => confined.mkdirSync()],
        ["rmSync", () => confined.rmSync()],
        ["rmdirSync", () => confined.rmdirSync()],
        ["unlinkSync", () => confined.unlinkSync()],
        ["renameSync", () => confined.renameSync()],
        ["copyFileSync", () => confined.copyFileSync()],
        ["chmodSync", () => confined.chmodSync()],
        ["symlinkSync", () => confined.symlinkSync()],
        ["createWriteStream", () => confined.createWriteStream()],
        ["watch", () => confined.watch()],
      ];
      for (const [name, call] of writers) {
        expect(call, `${name} must refuse`).toThrow(SandboxDeniedError);
      }
      // The grant is read-confined, so a granted root is still not writable.
      expect(confined.existsSync(target)).toBe(false);
    });

    test("the default export mirrors the named surface", () => {
      // A handler doing `import fs from "fs"` must meet the same refusals as one
      // doing `import { writeFileSync } from "fs"`.
      expect(confined.default.writeFileSync).toBe(confined.writeFileSync);
      expect(confined.default.readFileSync).toBe(confined.readFileSync);
      expect(confined.default.promises).toBe(confined.promises);
      expect(confined.constants.R_OK).toBeTypeOf("number");
    });
  });

  describe("confined-fs/promises — the async mirror", () => {
    test("reads inside the root and refuses outside it", async () => {
      setConfinedReadRoots([root]);
      expect(String(await confinedPromises.readFile(insideFile))).toBe(
        "inside"
      );
      expect((await confinedPromises.stat(insideFile))?.isFile()).toBe(true);
      expect((await confinedPromises.lstat(insideFile))?.isFile()).toBe(true);
      await expect(confinedPromises.readdir(root)).resolves.toContain(
        "readable.txt"
      );
      await expect(confinedPromises.realpath(insideFile)).resolves.toBe(
        insideFile
      );
      await expect(
        confinedPromises.access(insideFile)
      ).resolves.toBeUndefined();

      await expect(confinedPromises.readFile(outsideFile)).rejects.toThrow(
        SandboxDeniedError
      );
      await expect(confinedPromises.stat(outsideFile)).rejects.toThrow(
        SandboxDeniedError
      );
      await expect(confinedPromises.readdir(sibling)).rejects.toThrow(
        SandboxDeniedError
      );
      await expect(confinedPromises.access(outsideFile)).rejects.toThrow(
        SandboxDeniedError
      );
    });

    test("the async symlink escape is refused too", async () => {
      setConfinedReadRoots([root]);
      // The two mirrors share `guardReadPath`, and this is what proves the async
      // half actually calls it rather than reimplementing a weaker check.
      await expect(confinedPromises.readFile(escapeLink)).rejects.toThrow(
        SandboxDeniedError
      );
    });

    test("every async write entry point refuses", async () => {
      setConfinedReadRoots([root]);
      const writers: ReadonlyArray<[string, () => unknown]> = [
        ["writeFile", () => confinedPromises.writeFile()],
        ["appendFile", () => confinedPromises.appendFile()],
        ["mkdir", () => confinedPromises.mkdir()],
        ["rm", () => confinedPromises.rm()],
        ["rmdir", () => confinedPromises.rmdir()],
        ["unlink", () => confinedPromises.unlink()],
        ["rename", () => confinedPromises.rename()],
        ["copyFile", () => confinedPromises.copyFile()],
        ["chmod", () => confinedPromises.chmod()],
        ["symlink", () => confinedPromises.symlink()],
        // `open` is refused outright: a handle is a write primitive in disguise.
        ["open", () => confinedPromises.open()],
      ];
      for (const [name, call] of writers)
        expect(call, `${name} must refuse`).toThrow(SandboxDeniedError);
    });
  });

  describe("multiple roots", () => {
    test("a second granted root is admitted without widening the first", async () => {
      const second = path.join(base, "second");
      await fs.mkdir(second, { recursive: true });
      const secondFile = path.join(second, "ok.txt");
      await fs.writeFile(secondFile, "second");
      setConfinedReadRoots([root, second]);
      expect(confinedReadRoots()).toHaveLength(2);
      expect(String(confined.readFileSync(secondFile))).toBe("second");
      expect(String(confined.readFileSync(insideFile))).toBe("inside");
      // The ungranted sibling stays refused with two roots in play.
      expect(() => confined.readFileSync(outsideFile)).toThrow(
        SandboxDeniedError
      );
    });
  });
});
