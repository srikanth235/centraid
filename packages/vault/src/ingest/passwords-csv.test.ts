import { describe, expect, test } from "vitest";

import { isPasswordsCsvHeader, parsePasswordsCsv } from "./passwords-csv.js";

describe("passwords-csv", () => {
  test("isPasswordsCsvHeader requires a password column plus username or url", () => {
    expect(isPasswordsCsvHeader(["name", "password", "url"])).toBe(true);
    expect(isPasswordsCsvHeader(["login_username", "login_password"])).toBe(
      true
    );
    expect(isPasswordsCsvHeader(["name", "url"])).toBe(false);
    expect(isPasswordsCsvHeader(["password"])).toBe(false);
  });

  test("parsePasswordsCsv maps Chrome/1Password shape", () => {
    const text = [
      "name,url,username,password,notes",
      "GitHub,https://github.com,priya,s3cret,work account",
      ",,orphan-password-row,x,",
    ].join("\n");
    expect(parsePasswordsCsv(text)).toStrictEqual([
      {
        title: "GitHub",
        url: "https://github.com",
        username: "priya",
        password: "s3cret",
        otpSeed: null,
        notes: "work account",
      },
    ]);
  });

  test("parsePasswordsCsv maps Bitwarden aliases and extracts otpauth secrets", () => {
    const text = [
      "login_uri,login_username,login_password,login_totp",
      "https://mail.example,user@example.com,pass,otpauth://totp/Ex?secret=JBSWY3DPEHPK3PXP&issuer=Ex",
      "example.org,alice,pw,PLAINBASE32SEED",
    ].join("\n");
    const items = parsePasswordsCsv(text);
    expect(items).toStrictEqual([
      {
        title: "mail.example",
        url: "https://mail.example",
        username: "user@example.com",
        password: "pass",
        otpSeed: "JBSWY3DPEHPK3PXP",
        notes: null,
      },
      {
        title: "example.org",
        url: "example.org",
        username: "alice",
        password: "pw",
        otpSeed: "PLAINBASE32SEED",
        notes: null,
      },
    ]);
  });

  test("parsePasswordsCsv throws when the header is not a password export", () => {
    expect(() => parsePasswordsCsv("date,amount\n2026-01-01,10\n")).toThrow(
      /does not name a password column/u
    );
  });

  test("rejects formula-bearing display fields while preserving arbitrary passwords", () => {
    expect(() =>
      parsePasswordsCsv(
        [
          "name,url,username,password,notes",
          '=HYPERLINK("https://evil"),https://example.com,user,=real-password,note',
        ].join("\n")
      )
    ).toThrow(/spreadsheet formula marker/u);
    expect(
      parsePasswordsCsv(
        [
          "name,url,username,password,notes",
          "Safe,https://example.com,user,=real-password,note",
        ].join("\n")
      )[0]?.password
    ).toBe("=real-password");
  });
});
