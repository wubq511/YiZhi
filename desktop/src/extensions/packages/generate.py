# Build-time only: regenerate immutable manifests after reviewing package changes.
from pathlib import Path
import hashlib, json
root = Path(__file__).parent
for version, state, bits, parents in [('1.0.0','parity-state-1',3,[]), ('1.1.0','parity-state-2',3,['parity-state-1']), ('2.0.0','parity-state-3',4,[])]:
    folder = root / version
    folder.mkdir(exist_ok=True)
    for name in ['index.html','frame.js','compute.js','style.css','LICENSE.txt']:
        (folder/name).write_bytes((root/name).read_bytes())
    resources = []
    for name in ['index.html','frame.js','compute.js','style.css','LICENSE.txt']:
        data=(folder/name).read_bytes()
        resources.append(dict(path=name,sha256=hashlib.sha256(data).hexdigest(),byteLength=len(data),mediaType={'html':'text/html; charset=utf-8','js':'text/javascript','css':'text/css','txt':'text/plain'}[name.split('.')[-1]],license='MIT'))
    m=dict(packageId='parity-lab',packageVersion=version,interfaceVersion='extension-api-1',inputVersion=f'bits-{bits}-v1',stateVersion=state,entry='index.html',license='MIT',inputs=list('ABCD')[:bits],editableFields=list('ABCD')[:bits],resources=resources,migratesFrom=parents,learningResult='Odd parity of the declared bits; exhaustive finite minterms',stepMs=250)
    m['sha256']=hashlib.sha256(json.dumps(m,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    (folder/'manifest.json').write_text(json.dumps(m,ensure_ascii=False,indent=2)+'\n')
