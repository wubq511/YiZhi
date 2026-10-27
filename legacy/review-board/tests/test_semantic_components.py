from copy import deepcopy
import unittest
from reviewboard.semantic_components import component_contracts, validate_component, validate_changed_components
from reviewboard.storage import StoreError


class ComponentTests(unittest.TestCase):
    def payload(self, component):
        value=component_contracts()[component]
        return {"component":component,"config":value["config"],"inputs":value["inputs"]}

    def test_supported_mux_variants_and_decoder_match_installed_renderer(self):
        for name in ("mux","decoder","kmap"):
            validate_component(self.payload(name))
        payload={"component":"mux","config":{"selectBits":["S"],"dataSignals":["x","¬x"]},"inputs":{"S":0,"x":1}}
        validate_component(payload)
        for change in (lambda p:p['config'].update(dataSignals=['x']),lambda p:p['inputs'].update(x=2),
                       lambda p:p['config'].update(dataSignals=['x','y'])):
            bad=deepcopy(payload);change(bad)
            with self.assertRaises(StoreError):validate_component(bad)

    def test_kmap_that_would_render_a_false_four_one_claim_is_rejected(self):
        p=self.payload('kmap');p['config']['cells']=[[0,0,0,0],[0,0,0,0]]
        with self.assertRaises(StoreError) as caught:validate_component(p)
        self.assertEqual(caught.exception.code,'capability_unavailable')
        self.assertIn('supportedComponents',caught.exception.details)

    def test_non_138_decoder_configuration_is_rejected(self):
        for key,value in [('activeLowOutputs',False),('outputs',4),('enable',{'S1':1})]:
            p=self.payload('decoder');p['config'][key]=value
            with self.assertRaises(StoreError):validate_component(p)

    def test_unrelated_wording_edits_leave_existing_components_alone_but_new_invalid_component_fails(self):
        p=self.payload('kmap');p['config']['cells']=[[0]*4]*2
        original={'reading':{'blocks':[{'id':'legacy','kind':'interactive','payload':p}]}}
        current=deepcopy(original);current['summary']='wording'
        validate_changed_components(original,current)
        current['reading']['blocks'].append({'id':'new','kind':'interactive','payload':p})
        with self.assertRaises(StoreError):validate_changed_components(original,current)

