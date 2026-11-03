import json
import tempfile
import unittest
from pathlib import Path

from budget import BudgetExceeded, Ledger


class BudgetTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "r" / "ledger.jsonl"

    def tearDown(self):
        self.dir.cleanup()

    def lines(self):
        return [json.loads(l) for l in self.path.read_text().splitlines()]

    def test_caps_and_ceil(self):
        led = Ledger(self.path, 50)
        self.assertEqual(led.spend("generate", 512), [1])
        self.assertEqual(led.spend("generate", 513), [2, 3])
        self.assertEqual(led.spend("forward", 1024), [4])
        self.assertEqual(led.spend("forward", 2049), [5, 6, 7])
        self.assertEqual(led.passes_left, 43)
        self.assertEqual(self.lines()[1:3], [{"pass": 2, "kind": "generate", "n": 512}, {"pass": 3, "kind": "generate", "n": 1}])

    def test_exceed_writes_nothing(self):
        led = Ledger(self.path, 2)
        led.spend("generate", 1)
        with self.assertRaises(BudgetExceeded):
            led.spend("generate", 1025)
        self.assertEqual(len(self.lines()), 1)
        self.assertEqual(led.passes_left, 1)
        led.spend("forward", 5)
        with self.assertRaises(BudgetExceeded):
            led.spend("forward", 1)

    def test_resume(self):
        Ledger(self.path, 5).spend("generate", 1100)  # 3 passes
        again = Ledger(self.path, 5)
        self.assertEqual(again.passes_left, 2)
        self.assertEqual(again.spend("forward", 1), [4])
        with self.assertRaises(BudgetExceeded):
            again.spend("generate", 1100)

    def test_unknown_kind_and_zero(self):
        led = Ledger(self.path, 3)
        with self.assertRaises(ValueError):
            led.spend("train", 1)
        self.assertEqual(led.spend("generate", 0), [])
        self.assertFalse(self.path.exists())


if __name__ == "__main__":
    unittest.main()
