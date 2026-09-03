import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyFillToLiveFields,
  findFields,
  isLiveFillTarget,
  passwordForSaveFromFields,
} from "./page-fields.js";

function mountForm(html: string): HTMLFormElement {
  document.body.innerHTML = html;
  return document.body.querySelector("form")!;
}

function paintVisible(root: ParentNode = document): void {
  for (const input of root.querySelectorAll("input")) {
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 120,
      height: 24,
      top: 0,
      left: 0,
      right: 120,
      bottom: 24,
      toJSON: () => ({}),
    } as DOMRect);
  }
}

describe("page-fields", () => {
  beforeEach(() => {});

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  describe("findFields / isLiveFillTarget", () => {
    it("finds visible username and password inputs", () => {
      const form = mountForm(`
      <form>
        <input type="email" name="email" autocomplete="username" value="a@b.c" />
        <input type="password" name="password" autocomplete="current-password" value="secret" />
      </form>
    `);
      paintVisible(form);
      const fields = findFields();
      expect(fields.username?.name).toBe("email");
      expect(fields.password?.name).toBe("password");
      expect(isLiveFillTarget(fields.password)).toBe(true);
    });

    it("ignores display:none inputs even when they have a painted box", () => {
      const form = mountForm(`
      <form>
        <input type="password" name="hidden-pw" style="display:none" />
        <input type="password" name="vis-pw" />
      </form>
    `);
      paintVisible(form);
      const fields = findFields();
      expect(fields.password?.name).toBe("vis-pw");
    });

    it("skips detached inputs after SPA re-render", () => {
      const form = mountForm(`
      <form>
        <input type="password" name="old-pw" id="old" />
      </form>
    `);
      paintVisible(form);
      const stale = form.querySelector<HTMLInputElement>("#old")!;
      expect(isLiveFillTarget(stale)).toBe(true);
      form.innerHTML = '<input type="password" name="new-pw" id="new" />';
      paintVisible(form);
      expect(isLiveFillTarget(stale)).toBe(false);
      expect(findFields().password?.id).toBe("new");
    });
  });

  describe(applyFillToLiveFields, () => {
    it("writes only into still-connected live fields", () => {
      const form = mountForm(`
      <form>
        <input type="email" id="user" autocomplete="username" />
        <input type="password" id="pass" />
      </form>
    `);
      paintVisible(form);
      const staleUser = form.querySelector<HTMLInputElement>("#user")!;
      form.innerHTML = `
      <input type="email" id="user2" autocomplete="username" />
      <input type="password" id="pass2" />
    `;
      paintVisible(form);
      const live = findFields();
      const writes: string[] = [];
      const wrote = applyFillToLiveFields(
        { username: staleUser, password: live.password },
        { username: "alice", password: "p@ss" },
        (input, value) => {
          writes.push(`${input.id}:${value}`);
          input.value = value;
        }
      );
      expect(wrote.username).toBe(false);
      expect(wrote.password).toBe(true);
      expect(writes).toStrictEqual(["pass2:p@ss"]);
    });

    it("re-resolution at gesture time fills the replacement inputs", () => {
      const form = mountForm(`
      <form>
        <input type="password" id="old" />
      </form>
    `);
      form.innerHTML = `
      <input type="email" id="user" autocomplete="username" />
      <input type="password" id="pass" />
    `;
      paintVisible(form);
      const fields = findFields();
      const wrote = applyFillToLiveFields(
        fields,
        { username: "bob", password: "new-secret" },
        (input, value) => {
          input.value = value;
        }
      );
      expect(wrote).toStrictEqual({
        username: true,
        password: true,
        totp: false,
      });
      expect((document.querySelector("#user") as HTMLInputElement).value).toBe(
        "bob"
      );
      expect((document.querySelector("#pass") as HTMLInputElement).value).toBe(
        "new-secret"
      );
    });
  });

  describe(passwordForSaveFromFields, () => {
    it("prefers new-password over current password", () => {
      const form = mountForm(`
      <form>
        <input type="password" autocomplete="current-password" value="old" />
        <input type="password" autocomplete="new-password" value="fresh" />
      </form>
    `);
      paintVisible(form);
      expect(passwordForSaveFromFields(findFields())).toBe("fresh");
    });
  });
});
