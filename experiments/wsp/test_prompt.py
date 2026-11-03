import unittest

import catalog
import prompt

CAT = catalog.load()
ITEM = {"id": "agenda-001", "today": "2026-11-03", "me": "Sam Park", "history": [],
        "user": "put lunch with Sam on friday at noon"}


class FakeTokenizer:
    def __init__(self):
        self.kwargs = None

    def apply_chat_template(self, msgs, **kw):
        self.kwargs = kw
        return "|".join(m["role"] for m in msgs) + "<gen>"


class Messages(unittest.TestCase):
    def test_shape(self):
        msgs, tools, ids = prompt.messages(ITEM, CAT)
        self.assertEqual([m["role"] for m in msgs], ["system", "user"])
        self.assertEqual(msgs[-1]["content"], ITEM["user"])
        self.assertEqual(len(ids), 8)
        self.assertIn("agenda.propose", ids)

    def test_system_content(self):
        sys_text = prompt.messages(ITEM, CAT)[0][0]["content"]
        self.assertIn("today: Tuesday 2026-11-03", sys_text)
        self.assertIn("me: Sam Park", sys_text)
        self.assertIn("candidates:", sys_text)
        self.assertIn("exactly one tool call", sys_text)
        for line in sys_text.split("candidates:\n")[1].splitlines():
            self.assertIn(" — ", line)

    def test_candidate_line_format(self):
        line = prompt.entry_line(CAT["agenda.propose"])
        self.assertTrue(line.startswith("agenda.propose (act, event, create) — Propose an event"))
        self.assertIn("starts*: when, title*: text", line)
        self.assertIn("calendar: mention<calendar>", line)
        self.assertIn("status: enum(confirmed|tentative|cancelled)", line)
        self.assertNotIn("[card]", line)
        self.assertTrue(prompt.entry_line(CAT["agenda.purge-task"]).endswith(" [card]"))
        self.assertIn("(view, event, read)", prompt.entry_line(CAT["agenda.upcoming"]))

    def test_tools(self):
        tools = prompt.tools()
        self.assertEqual([t["function"]["name"] for t in tools], ["act", "load", "ask", "decline"])
        for t in tools:
            self.assertEqual(t["type"], "function")
            self.assertEqual(t["function"]["parameters"]["type"], "object")
        self.assertEqual(tools[3]["function"]["parameters"]["properties"]["reason"]["enum"],
                         ["out_of_scope", "never_mind", "fabricated_secret", "unbounded_destruction"])

    def test_history_turns(self):
        item = dict(ITEM, user="and make it 1pm", history=[
            {"user": "add lunch tomorrow", "call": {"tool": "act", "name": "agenda.propose",
                                                  "args": {"title": "lunch", "starts": "tomorrow"}}}])
        msgs, _, _ = prompt.messages(item, CAT)
        self.assertEqual([m["role"] for m in msgs], ["system", "user", "assistant", "tool", "user"])
        call = msgs[2]["tool_calls"][0]["function"]
        self.assertEqual(call["name"], "act")
        self.assertEqual(call["arguments"], {"action": "agenda.propose",
                                              "input": {"title": "lunch", "starts": "tomorrow"}})
        self.assertEqual(msgs[2]["content"], "")
        self.assertEqual(msgs[3], {"role": "tool", "content": "ok"})

    def test_history_feeds_retrieval(self):
        item = dict(ITEM, user="make it 1pm", history=[
            {"user": "put lunch with Sam on friday at noon", "call": {"tool": "ask", "args": {"question": "q"}}}])
        _, _, ids = prompt.messages(item, CAT)
        self.assertIn("agenda.propose", ids)

    def test_deterministic(self):
        self.assertEqual(prompt.messages(ITEM, CAT), prompt.messages(ITEM, CAT))


class Render(unittest.TestCase):
    def test_render_calls_template(self):
        tok = FakeTokenizer()
        text, ids = prompt.render(ITEM, CAT, tok)
        self.assertEqual(text, "system|user<gen>")
        self.assertEqual(tok.kwargs["enable_thinking"], False)  # off by default: the call is the target
        prompt.render(ITEM, CAT, tok, thinking=True)
        self.assertEqual(tok.kwargs["enable_thinking"], True)
        self.assertEqual(tok.kwargs["add_generation_prompt"], True)
        self.assertEqual(tok.kwargs["tokenize"], False)
        self.assertEqual(len(tok.kwargs["tools"]), 4)
        self.assertIn("agenda.propose", ids)


if __name__ == "__main__":
    unittest.main()
