import unittest

from adapter_train import config

REV = "a" * 40


def job(**over):
    obj = {"name": "adapter-v1", "base": {"model": "Qwen/Qwen3.5-0.8B", "revision": REV},
           "data": {"train": "s3://b/train.jsonl.zst"}, "checkpoints": "s3://b/ckpt", "outputs": "s3://b/out"}
    obj.update(over)
    return obj


class ConfigTest(unittest.TestCase):
    def test_a_minimal_job_gets_the_defaults(self):
        j = config.parse(job())
        self.assertEqual(j.lora.targets, config.DEFAULT_TARGETS)
        self.assertNotIn("in_proj_a", j.lora.targets)  # skipped by default
        self.assertNotIn("in_proj_b", j.lora.targets)
        self.assertEqual((j.base_weights, j.lora.rank), ("hf", 16))
        self.assertIsNone(j.val)

    def test_the_default_targets_are_the_shippable_ones_less_the_opt_in_pair(self):
        self.assertEqual(set(config.DEFAULT_TARGETS), set(config.SHIPPABLE) - set(config.OPT_IN))
        self.assertEqual(len(config.DEFAULT_TARGETS), 10)

    def test_embeddings_and_the_head_are_refused_with_a_reason(self):
        for t in ("embed_tokens", "lm_head"):
            with self.assertRaisesRegex(config.ConfigError, "never a target"):
                config.parse(job(lora={"targets": ["q_proj", t]}))

    def test_a_module_the_converter_cannot_ship_is_refused(self):
        for t in ("conv1d", "visual_proj", "input_layernorm", "o_projj"):
            with self.assertRaisesRegex(config.ConfigError, "can ship"):
                config.parse(job(lora={"targets": [t]}))

    def test_the_small_gates_are_allowed_when_asked_for(self):
        j = config.parse(job(lora={"targets": ["in_proj_a", "in_proj_b", "q_proj"]}))
        self.assertEqual(j.lora.targets, ("in_proj_a", "in_proj_b", "q_proj"))

    def test_the_regex_matches_the_language_model_and_nothing_else(self):
        import re

        rx = re.compile(config.target_regex(config.DEFAULT_TARGETS))
        yes = ["model.layers.3.self_attn.q_proj", "model.language_model.layers.0.linear_attn.in_proj_qkv", "model.layers.12.mlp.down_proj",
               "base_model.model.model.layers.5.linear_attn.out_proj"]
        no = ["model.embed_tokens", "lm_head", "model.layers.3.linear_attn.in_proj_a", "model.layers.3.linear_attn.in_proj_b",
              "model.visual.blocks.0.attn.qkv", "model.visual.blocks.0.attn.proj", "model.layers.3.input_layernorm",
              "model.layers.3.linear_attn.conv1d", "model.layers.3.mlp.down_proj.base_layer"]
        for name in yes:
            self.assertTrue(rx.fullmatch(name), name)
        for name in no:
            self.assertFalse(rx.fullmatch(name), name)

    def test_a_branch_is_not_a_revision(self):
        for rev in ("main", "v1", "abc123", "A" * 40):
            with self.assertRaisesRegex(config.ConfigError, "commit hash"):
                config.parse(job(base={"model": "Qwen/Qwen3.5-0.8B", "revision": rev}))

    def test_unknown_keys_are_refused_at_every_level(self):
        for bad in (job(extra=1), job(lora={"rnak": 8}), job(train={"stepz": 3}), job(data={"train": "x", "test": "y"})):
            with self.assertRaisesRegex(config.ConfigError, "unknown key"):
                config.parse(bad)

    def test_there_is_no_knob_for_new_tokens_or_embeddings(self):
        for key in ("modules_to_save", "new_tokens", "resize_embeddings", "train_embeddings"):
            with self.assertRaises(config.ConfigError):
                config.parse(job(lora={key: True}))

    def test_locations_are_a_path_s3_or_gs(self):
        config.parse(job(checkpoints="/mnt/ckpt", outputs="gs://b/out"))
        for bad in ("ftp://b/x", "s3://", "  "):
            with self.assertRaises(config.ConfigError):
                config.parse(job(outputs=bad))

    def test_the_phones_own_weights_need_the_file(self):
        with self.assertRaisesRegex(config.ConfigError, "needs base.gguf"):
            config.parse(job(base={"model": "m", "revision": REV, "weights": "q4_0_dequantised"}))
        with self.assertRaisesRegex(config.ConfigError, "only read with"):
            config.parse(job(base={"model": "m", "revision": REV, "gguf": "x.gguf"}))
        config.parse(job(base={"model": "m", "revision": REV, "weights": "q4_0_dequantised", "gguf": "s3://b/q.gguf"}))

    def test_numbers_are_checked(self):
        for lora in ({"rank": 0}, {"rank": 1000}, {"alpha": 0}, {"dropout": 1.0}, {"rank": True}):
            with self.assertRaises(config.ConfigError):
                config.parse(job(lora=lora))
        with self.assertRaises(config.ConfigError):
            config.parse(job(train={"eval_every": 5}))  # no val set

    def test_the_digest_ignores_key_order(self):
        a = config.loads('{"name":"n","base":{"model":"m","revision":"%s"},"data":{"train":"x"},"checkpoints":"c","outputs":"o"}' % REV)
        b = config.loads('{"outputs":"o","checkpoints":"c","data":{"train":"x"},"base":{"revision":"%s","model":"m"},"name":"n"}' % REV)
        self.assertEqual(a.digest(), b.digest())
        self.assertRaises(config.ConfigError, config.loads, "{not json")


if __name__ == "__main__":
    unittest.main()
