#!/usr/bin/env python3
"""Repo analysis: files, sizes, file types, lines, and tests — quick numbered overview."""
import os
import subprocess
import sys
from collections import Counter, defaultdict

EXCLUDED_DIRS = {'.git', 'node_modules', 'dist', 'coverage', 'vendor', '.venv'}
CODE_EXTS = {'.ts', '.js', '.jsx', '.tsx', '.py', '.sh', '.go', '.rs', '.java', '.kt', '.md', '.json', '.css', '.html'}


def list_files(root):
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIRS]
        for name in filenames:
            files.append(os.path.join(dirpath, name))
    return files


def filter_gitignored(root, files):
    if not os.path.isdir(os.path.join(root, '.git')):
        return files
    try:
        proc = subprocess.run(
            ['git', '-C', root, 'check-ignore', '--stdin'],
            input='\n'.join(files) + '\n', capture_output=True, text=True
        )
    except Exception:
        return files
    ignored = set(proc.stdout.splitlines())
    return [f for f in files if f not in ignored]


def analyze(root):
    files = filter_gitignored(root, list_files(root))

    total_bytes = 0
    ext_counter = Counter()
    ext_lines = defaultdict(int)
    test_files = []
    test_cases = 0
    largest = []

    for f in files:
        size = os.path.getsize(f)
        total_bytes += size
        largest.append((size, f))
        ext = os.path.splitext(f)[1].lower() or '<none>'
        ext_counter[ext] += 1

        base = os.path.basename(f)
        is_test = ('.test.' in f or '.spec.' in f or base.startswith('test_')
                   or base.endswith(('_test.py', '_test.go', '_test.rs', 'Test.java', 'Tests.java'))
                   or '__tests__' in f)
        if is_test:
            test_files.append(f)

        if ext in CODE_EXTS:
            try:
                with open(f, 'r', errors='ignore') as fh:
                    ext_lines[ext] += sum(1 for _ in fh)
            except OSError:
                pass

    for f in test_files:
        try:
            with open(f, 'r', errors='ignore') as fh:
                text = fh.read()
        except OSError:
            continue
        for line in text.splitlines():
            s = line.lstrip()
            if s.startswith(('it(', 'test(', 'describe(', 'def test_', 'func Test')):
                test_cases += 1

    largest.sort(reverse=True)
    return {
        'root': root,
        'count': len(files),
        'total_mb': total_bytes / (1024 * 1024),
        'largest': largest[:15],
        'ext_counter': ext_counter,
        'ext_lines': ext_lines,
        'test_files': len(test_files),
        'test_cases': test_cases,
    }


def main():
    root = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '.')
    if not os.path.isdir(root):
        print(f'Error: not a directory: {root}')
        sys.exit(1)

    r = analyze(root)

    print('=' * 50)
    print(f'   REPO ANALYSIS: {r["root"]}')
    print('=' * 50)

    print('\n1) FILES')
    print(f'   Total files (excl .git/node_modules/dist/coverage/vendor/.venv and gitignored): {r["count"]}')

    print('\n2) SIZE')
    print(f'   Total size: {r["total_mb"]:.1f} MB')

    print('\n3) LARGEST FILES (top 15)')
    for i, (size, f) in enumerate(r['largest'], 1):
        rel = os.path.relpath(f, r['root'])
        print(f'   {i:2d}. {size / 1024:10.1f} KB  {rel}')

    print('\n4) FILE TYPES (top 20 by count)')
    for i, (ext, count) in enumerate(r['ext_counter'].most_common(20), 1):
        print(f'   {i:2d}. {count:6d}  {ext}')

    print('\n5) LINES BY EXTENSION (top 10)')
    for i, (ext, lines) in enumerate(sorted(r['ext_lines'].items(), key=lambda kv: -kv[1])[:10], 1):
        print(f'   {i:2d}. {lines:10d} lines  {ext}')

    print('\n6) TESTS')
    print(f'   Test files: {r["test_files"]}')
    print(f'   Test cases (approx): {r["test_cases"]}')

    print('\n' + '=' * 50)


if __name__ == '__main__':
    main()
