import json
from pathlib import Path
import subprocess
import unittest


PROVIDER = Path(__file__).parents[1] / "web/content/provider.js"


class InteractiveLogicTests(unittest.TestCase):
    def evaluate(self, function, cases):
        script = (
            "const provider=require(process.argv[1]);"
            "const cases=JSON.parse(require('fs').readFileSync(0,'utf8'));"
            "process.stdout.write(JSON.stringify(cases.map(item=>provider.logic[process.argv[2]](item.config,item.inputs))));"
        )
        result = subprocess.run(["node", "-e", script, str(PROVIDER), function],
                                input=json.dumps(cases), text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_mux_matches_four_channel_truth_table(self):
        config = {"selectBits": ["S1", "S0"], "dataSignals": ["z", "¬z", "0", "1"]}
        cases = [{"config": config, "inputs": {"S1": s1, "S0": s0, "z": z}}
                 for s1 in (0, 1) for s0 in (0, 1) for z in (0, 1)]
        actual = self.evaluate("evaluateMux", cases)
        for case, result in zip(cases, actual):
            inputs = case["inputs"]
            index = inputs["S1"] * 2 + inputs["S0"]
            expected = [inputs["z"], 1 - inputs["z"], 0, 1][index]
            self.assertEqual(result, {"selectedIndex": index, "value": expected})

    def test_decoder_matches_enable_and_active_low_truth_table(self):
        config = {"addressBits": ["A2", "A1", "A0"], "outputs": 8,
                  "enable": {"S1": 1, "S2": 0, "S3": 0}, "activeLowOutputs": True}
        cases = [{"config": config, "inputs": {"A2": a2, "A1": a1, "A0": a0,
                                               "S1": s1, "S2": s2, "S3": s3}}
                 for s1 in (0, 1) for s2 in (0, 1) for s3 in (0, 1)
                 for a2 in (0, 1) for a1 in (0, 1) for a0 in (0, 1)]
        actual = self.evaluate("evaluateDecoder", cases)
        for case, result in zip(cases, actual):
            inputs = case["inputs"]
            enabled = (inputs["S1"], inputs["S2"], inputs["S3"]) == (1, 0, 0)
            selected = inputs["A2"] * 4 + inputs["A1"] * 2 + inputs["A0"]
            outputs = [1 - int(enabled and index == selected) for index in range(8)]
            self.assertEqual(result, {"enabled": enabled, "selectedIndex": selected,
                                      "outputs": outputs})


if __name__ == "__main__":
    unittest.main()
