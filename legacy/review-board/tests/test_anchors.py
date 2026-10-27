import json
from pathlib import Path
import tempfile
import unittest
from test_content_commands import fixture,REF
from reviewboard.service import CourseService


class AnchorLifecycleTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        self.root=Path(temp.name);self.path=fixture(self.root)
        data=json.loads(self.path.read_text());data['themes'][0]['lessonId']='L-01'
        self.path.write_text(json.dumps(data))
        self.service=CourseService(self.root);self.addCleanup(self.service.close)

    def add(self,namespace,key,block=None):
        anchor={'objectId':'KU-001','blockId':block,'revision':1,'originalText':'paragraph 1','sourceRefs':[REF]}
        value={'objectId':'KU-001','anchor':anchor}
        if namespace=='notes':value.update(noteId=key,text='keep my thinking')
        else:value.update(drawingId=key,tool='wave')
        self.service.apply_command({'operationId':'add-'+key,'actor':'student','kind':'personal.edit','generation':1,
            'changes':[{'namespace':namespace,'key':key,'value':value}],'expectedRevisions':{namespace+':'+key:0}})

    def retire(self,**mapping):
        data=json.loads(self.path.read_text());data['units']=[u for u in data['units'] if u['id']!='KU-001']
        data['retiredUnits']=[{'id':'KU-001','status':'retired',**mapping}]
        self.path.write_text(json.dumps(data))

    def test_explicit_merge_follows_object_note_and_drawing_once_with_original_context(self):
        self.add('notes','NOTE-one');self.add('annotations','DRAW-one')
        self.retire(mergedInto='KU-002');self.service.open_course()
        for ns,key in [('notes','NOTE-one'),('annotations','DRAW-one')]:
            first=self.service.store.read(ns,key)
            self.assertEqual(first['value']['objectId'],'KU-002')
            self.assertEqual(first['value']['anchor']['originalAnchor']['objectId'],'KU-001')
            self.service.open_course();self.assertEqual(self.service.store.read(ns,key),first)

    def test_unique_surviving_fragment_follows_without_copying(self):
        self.add('notes','NOTE-fragment','RB-KU-001-1')
        self.retire(mergedInto='KU-002');self.service.open_course()
        note=self.service.store.read('notes','NOTE-fragment')['value']
        self.assertEqual(note['anchor']['blockId'],'RB-KU-002-1')
        self.assertEqual(note['anchor']['originalAnchor']['blockId'],'RB-KU-001-1')
        self.assertEqual(len(self.service.store.list('notes')),1)

    def test_ambiguous_split_keeps_original_personal_identity_for_manual_reassociation(self):
        self.add('notes','NOTE-ambiguous','RB-KU-001-1')
        before=self.service.store.read('notes','NOTE-ambiguous')
        self.retire(splitInto=['KU-002','KU-003']);self.service.open_course()
        self.assertEqual(self.service.store.read('notes','NOTE-ambiguous'),before)
        self.assertEqual(len(self.service.store.list('notes')),1)
