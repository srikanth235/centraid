import unittest

import catalog
import retrieve

CAT = catalog.load()


class Retrieval(unittest.TestCase):
    def test_lunch_with_sam(self):
        self.assertIn("agenda.propose", retrieve.candidates("put lunch with Sam on friday at noon", CAT))

    def test_other_queries(self):
        cases = {
            "rename the lease doc to apartment lease": "docs.rename",
            "mark the dentist event as done": None,
            "show me the password for my bank login": "locker.reveal",
            "file that Starbucks charge under coffee": "money.categorize",
            "remind me to reach out to Sam every month": "people.set-cadence",
            "take the beach photo out of Italy 2026": "photos.remove-from-album",
        }
        for text, gold in cases.items():
            if gold:
                self.assertIn(gold, retrieve.candidates(text, CAT), text)

    def test_k_and_determinism(self):
        a = retrieve.candidates("anything about events", CAT, k=5)
        self.assertEqual(len(a), 5)
        self.assertEqual(a, retrieve.candidates("anything about events", CAT, k=5))
        self.assertEqual(len(set(a)), 5)

    def test_ties_by_id(self):
        out = retrieve.candidates("zzzzqq xxyyww", CAT, k=4)
        self.assertEqual(out, sorted(CAT)[:4])

    def test_tokenize(self):
        self.assertEqual(retrieve.tokenize("Put the Events, on 5pm!"), ["put", "event", "5pm"])

    def test_empty_catalog(self):
        self.assertEqual(retrieve.candidates("x", {}), [])


if __name__ == "__main__":
    unittest.main()
