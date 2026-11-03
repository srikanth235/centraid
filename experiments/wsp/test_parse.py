import unittest

import parse

XML = """<tool_call>
<function=act>
<parameter=action>
agenda.propose
</parameter>
<parameter=input>
{"title": "dentist", "starts": "thursday 4pm"}
</parameter>
</function>
</tool_call>"""


class ParseTest(unittest.TestCase):
    def test_xml_act(self):
        out = parse.parse_output("I should schedule it.\n</think>\n\n" + XML)
        call = out["call"]
        self.assertIsNone(call["error"])
        self.assertEqual((call["tool"], call["name"]), ("act", "agenda.propose"))
        self.assertEqual(call["args"], {"title": "dentist", "starts": "thursday 4pm"})
        self.assertEqual(out["think"], "I should schedule it.")
        self.assertTrue(out["think_closed"])

    def test_xml_load_ask_decline(self):
        load = parse.parse_call('<tool_call>\n<function=load>\n<parameter=view>\nagenda.day\n</parameter>\n<parameter=params>\n{"day": "today"}\n</parameter>\n</function>\n</tool_call>')
        self.assertEqual((load["tool"], load["name"], load["args"]), ("load", "agenda.day", {"day": "today"}))
        ask = parse.parse_call("<tool_call>\n<function=ask>\n<parameter=question>\nWhich Sam?\n</parameter>\n</function>\n</tool_call>")
        self.assertEqual((ask["tool"], ask["name"], ask["args"]), ("ask", None, {"question": "Which Sam?"}))
        dec = parse.parse_call("<tool_call>\n<function=decline>\n<parameter=reason>\nnever_mind\n</parameter>\n</function>\n</tool_call>")
        self.assertEqual(dec["args"], {"reason": "never_mind"})

    def test_hermes_json(self):
        call = parse.parse_call('<tool_call>{"name": "act", "arguments": {"action": "a.b", "input": {"x": "y"}}}</tool_call>')
        self.assertEqual((call["tool"], call["name"], call["args"], call["error"]), ("act", "a.b", {"x": "y"}, None))
        call = parse.parse_call('<tool_call>\n{"name": "ask", "arguments": {"question": "when?"}}\n</tool_call>')
        self.assertEqual(call["args"], {"question": "when?"})
        call = parse.parse_call('<tool_call>{"name": "act", "arguments": {"action": "a.b", "input": "{\\"x\\": 1}"}}</tool_call>')
        self.assertEqual(call["args"], {"x": 1})

    def test_missing_call(self):
        out = parse.parse_output("thinking only\n</think>\n\nSure, done.")
        self.assertEqual(out["call"]["error"], "no_tool_call")
        self.assertIsNone(out["call"]["tool"])

    def test_broken_json(self):
        xml = XML.replace('{"title": "dentist", "starts": "thursday 4pm"}', '{"title": "dentist", ')
        call = parse.parse_call(xml)
        self.assertTrue(call["error"].startswith("bad_input_json"))
        self.assertEqual((call["tool"], call["name"]), ("act", "agenda.propose"))
        self.assertTrue(parse.parse_call("<tool_call>{nope</tool_call>")["error"].startswith("bad_json"))

    def test_lenient_json(self):
        call = parse.parse_call(XML.replace('{"title": "dentist", "starts": "thursday 4pm"}', "{'title': 'dentist',}"))
        self.assertIsNone(call["error"])
        self.assertEqual(call["args"], {"title": "dentist"})
        self.assertTrue(call["repaired"])

    def test_input_not_object_and_missing_param(self):
        self.assertEqual(parse.parse_call(XML.replace('{"title": "dentist", "starts": "thursday 4pm"}', "[1]"))["error"], "input_not_object")
        self.assertEqual(parse.parse_call("<tool_call>\n<function=act>\n<parameter=action>\na.b\n</parameter>\n</function>\n</tool_call>")["error"], "missing_param:input")

    def test_unknown_tool(self):
        self.assertEqual(parse.parse_call("<tool_call>\n<function=rm>\n</function>\n</tool_call>")["error"], "unknown_tool")

    def test_think_variants(self):
        # prompt already opened <think>: raw starts inside it
        self.assertEqual(parse.parse_output("a b\n</think>\n\n" + XML)["think"], "a b")
        # model repeats the opening tag
        self.assertEqual(parse.parse_output("<think>\na b\n</think>\n\n" + XML)["think"], "a b")
        # unclosed (capped before the harness closes it, or never closed): the whole text is think
        out = parse.parse_output("a b c, still thinking")
        self.assertEqual((out["think"], out["think_closed"]), ("a b c, still thinking", False))
        # unclosed think followed directly by a call
        out = parse.parse_output("hmm\n" + XML)
        self.assertEqual(out["think"], "hmm")
        self.assertIsNone(out["call"]["error"])

    def test_capped_raw(self):
        # what run.py builds when the cap is hit: think text + "\n</think>\n\n" + call
        out = parse.parse_output("long thought without end" + "\n</think>\n\n" + XML)
        self.assertTrue(out["think_closed"])
        self.assertEqual(out["think"], "long thought without end")
        self.assertEqual(out["call"]["name"], "agenda.propose")

    def test_missing_close_tag(self):
        out = parse.parse_call(XML[: -len("</tool_call>")])
        self.assertIsNone(out["error"])


if __name__ == "__main__":
    unittest.main()
