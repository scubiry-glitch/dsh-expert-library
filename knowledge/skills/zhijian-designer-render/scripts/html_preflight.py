#!/usr/bin/env python3
"""Static, explicitly partial HTML preflight. No browser/PDF/math PASS claim."""
import argparse
import json
import pathlib
import re
import sys
from html.parser import HTMLParser

class Scan(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack=[]; self.chapters=[]; self.figures=0; self.errors=[]
    def handle_starttag(self, tag, attrs):
        attrs=dict(attrs); hidden=bool(self.stack and self.stack[-1][1]) or tag in ('script','style','template') or 'hidden' in attrs or attrs.get('aria-hidden')=='true' or bool(re.search(r'display\s*:\s*none|visibility\s*:\s*hidden',attrs.get('style',''),re.I))
        chapter=None
        if tag=='section' and not hidden and ('chapter' in attrs.get('class','').split() or 'data-craft-chapter' in attrs):
            chapter={'id':attrs.get('id'), 'text':[]}; self.chapters.append(chapter)
        if tag=='figure' and not hidden: self.figures+=1
        if tag not in ('area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'): self.stack.append((tag,hidden,chapter))
    def handle_endtag(self,tag):
        for i in range(len(self.stack)-1,-1,-1):
            if self.stack[i][0]==tag:
                del self.stack[i:]; return
    def handle_data(self,data):
        if self.stack and not self.stack[-1][1]:
            for _,_,chapter in self.stack:
                if chapter is not None: chapter['text'].append(data)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('html'); parser.add_argument('--min-chars',type=int,default=80); parser.add_argument('--min-figures',type=int,default=0)
    args=parser.parse_args()
    if args.min_chars<1 or args.min_figures<0: parser.error('positive min-chars / nonnegative min-figures required')
    path=pathlib.Path(args.html)
    try: source=path.read_text(encoding='utf-8'); scan=Scan(); scan.feed(source); scan.close()
    except (OSError,UnicodeError) as error:
        print(json.dumps({'status':'precheck_failed','error':type(error).__name__,'completeQualityApproved':False}));return 1
    errors=[]; chapters=[]
    if not scan.chapters: errors.append('NO_ANALYSIS_CHAPTER_SECTIONS: declare visible section.chapter or data-craft-chapter; empty structure cannot pass')
    for chapter in scan.chapters:
        text=' '.join(' '.join(chapter['text']).split());count=len(text);markers=re.findall(r'attempt_id|\bt\d+-S\d+\b|\bSP-\d+\b',text)
        chapters.append({'id':chapter['id'],'characters':count,'processMarkerCount':len(markers)})
        if count<args.min_chars:errors.append('SHORT_CHAPTER: '+str(chapter['id']))
        if markers:errors.append('PROCESS_MARKERS: '+str(chapter['id']))
    if scan.figures<args.min_figures:errors.append('TOO_FEW_ACTUAL_FIGURE_ELEMENTS')
    report={'status':'precheck_failed' if errors else 'precheck_pass','scope':'Static visible-markup chapter text/figure count/process-marker precheck only; no browser, AA, math, PDF or semantic approval.','completeQualityApproved':False,'chapters':chapters,'figureElements':scan.figures,'errors':errors}
    print(json.dumps(report,ensure_ascii=False,indent=2));return int(bool(errors))
if __name__=='__main__':sys.exit(main())
