#!/usr/bin/env python3
"""Verify generated standalone render-copy manifest; not a Host quality receipt."""
import hashlib
import json
import pathlib
import sys

def verify(root):
    root=root.resolve(); manifest=json.loads((root/'materials.generated.json').read_text()); ids=set(); paths=set()
    if manifest.get('schemaVersion')!=1 or manifest.get('materialPackId')!='zhijian-report-craft-v2':raise ValueError('invalid copy manifest identity')
    entries=manifest.get('entries')
    if not isinstance(entries,list) or not entries:raise ValueError('empty copy manifest')
    for item in entries:
        relative=pathlib.PurePosixPath(item['path'])
        if item['id'] in ids or item['path'] in paths:raise ValueError('duplicate copy identity')
        ids.add(item['id']);paths.add(item['path'])
        if relative.is_absolute() or '..' in relative.parts or '\\' in item['path']:raise ValueError('copy path escape')
        target=(root/item['path']).resolve()
        if not target.is_relative_to(root):raise ValueError('copy symlink escape')
        raw=target.read_bytes()
        if len(raw)!=item['bytes'] or hashlib.sha256(raw).hexdigest()!=item['sha256']:raise ValueError('copy bytes changed: '+item['id'])
    return {'status':'copy_integrity_pass','materialPackId':manifest['materialPackId'],'checkedFiles':len(entries),'scope':'Standalone generated copy integrity only; Host validates the compiled full-pack digest independently.','completeQualityApproved':False}
if __name__=='__main__':
    try:print(json.dumps(verify(pathlib.Path(__file__).resolve().parent.parent)))
    except (OSError,ValueError,KeyError,TypeError) as error:
        print(json.dumps({'status':'copy_integrity_failed','error':str(error),'completeQualityApproved':False}));sys.exit(1)
