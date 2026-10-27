#!/usr/bin/env python3
"""Print all comments in a .docx: id, author, date, comment text, and the body
text each comment anchors to.

`pandoc -t markdown` drops comments entirely; `--track-changes=all` inlines them
into the body prose. This script gives the clean list.

Usage:
    python scripts/extract_comments.py file.docx
    python scripts/extract_comments.py unpacked_dir/     # already-unzipped docx

Accepts a .docx or an unpacked directory. Exits 0 and says so when there are no
comments.
"""
import argparse
import os
import sys
import xml.etree.ElementTree as ET
import zipfile

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'


def qn(tag):
    return '{%s}%s' % (W, tag)


def para_text(p):
    parts = []
    for node in p.iter():
        if node.tag in (qn('t'), qn('delText')):
            parts.append(node.text or '')
        elif node.tag == qn('tab'):
            parts.append('\t')
        elif node.tag == qn('br'):
            parts.append(' / ')
    return ''.join(parts)


def read_xml(path_or_zip, part):
    """Return parsed XML for `part` from a .docx file or an unpacked directory."""
    if os.path.isdir(path_or_zip):
        full = os.path.join(path_or_zip, part)
        if not os.path.exists(full):
            return None
        return ET.parse(full).getroot()
    with zipfile.ZipFile(path_or_zip) as z:
        if part not in z.namelist():
            return None
        return ET.fromstring(z.read(part))


def get(root, tag, attr):
    el = root.find(qn(tag))
    return el.get(qn(attr)) if el is not None else None


def anchors(body_root):
    """Map comment id -> anchor text between its commentRangeStart/End.

    A range may wrap only an embedded image (no text); those anchors read
    '[embedded image]' rather than empty.
    """
    def render(state):
        text = ' '.join(t for t in state['texts'] if t.strip()).strip()
        img = ' [embedded image]' if state['img'] else ''
        return (text + img).strip()

    result = {}
    active = {}  # id -> {'texts': [...], 'img': bool}
    for p in body_root.iter(qn('p')):
        text = para_text(p)
        has_img = (p.find('.//' + qn('drawing')) is not None
                   or p.find('.//' + qn('pict')) is not None)
        starts = [e.get(qn('id')) for e in p.iter(qn('commentRangeStart'))]
        ends = [e.get(qn('id')) for e in p.iter(qn('commentRangeEnd'))]
        for i in starts:
            active[i] = {'texts': [], 'img': False}
        for state in active.values():
            state['texts'].append(text)
            state['img'] = state['img'] or has_img
        for i in ends:
            if i in active:
                result[i] = render(active.pop(i))
    for i, state in active.items():  # range never closed — take what we saw
        result[i] = render(state)
    return result


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('docx', help='.docx file or unpacked docx directory')
    ap.add_argument('--max-anchor', type=int, default=200,
                    help='truncate anchor text to N chars (0 = no limit)')
    args = ap.parse_args()

    croot = read_xml(args.docx, 'word/comments.xml')
    if croot is None:
        print('No comments found (word/comments.xml missing).')
        return 0

    body_root = read_xml(args.docx, 'word/document.xml')
    anchors_by_id = anchors(body_root) if body_root is not None else {}

    comments = croot.findall(qn('comment'))
    if not comments:
        print('No comments found.')
        return 0

    try:
        comments.sort(key=lambda c: int(c.get(qn('id'))))
    except (TypeError, ValueError):
        pass
    for c in comments:
        cid = c.get(qn('id'))
        text = ' '.join(para_text(p) for p in c.findall(qn('p'))).strip()
        text = ' '.join(text.split())
        print('COMMENT %s' % cid)
        print('  Author: %s' % c.get(qn('author')))
        print('  Date:   %s' % c.get(qn('date')))
        print('  Text:   %s' % text)
        anchor = anchors_by_id.get(cid)
        if anchor:
            if args.max_anchor and len(anchor) > args.max_anchor:
                anchor = anchor[:args.max_anchor].rstrip() + '…'
            print('  Anchor: %s' % ' '.join(anchor.split()))
        else:
            print('  Anchor: (no commentRangeStart/End in body)')
        print()
    return 0


if __name__ == '__main__':
    sys.exit(main())
