from pathlib import Path
text = Path('/tmp/moola_large_script.js').read_text()
frames = [{'type': 'normal', 'state': 'normal', 'brace_stack': []}]
i = 0
line = 1
col = 0
while i < len(text):
    ch = text[i]
    if ch == '\n':
        line += 1
        col = 0
        if frames[-1]['type'] == 'line_comment':
            frames.pop()
        i += 1
        continue
    col += 1
    frame = frames[-1]
    if frame['type'] == 'normal':
        if frame['state'] == 'escape':
            frame['state'] = 'normal'
        elif ch == '\\':
            frame['state'] = 'escape'
        elif ch == '"':
            frames.append({'type': 'string', 'quote': '"', 'state': 'normal'})
        elif ch == "'":
            frames.append({'type': 'string', 'quote': "'", 'state': 'normal'})
        elif ch == '`':
            frames.append({'type': 'template', 'state': 'normal'})
        elif ch == '/':
            nxt = text[i+1] if i+1 < len(text) else ''
            if nxt == '/':
                frames.append({'type': 'line_comment', 'state': 'normal'})
                i += 1
                col += 1
            elif nxt == '*':
                frames.append({'type': 'block_comment', 'state': 'normal'})
                i += 1
                col += 1
        elif ch in '([{':
            frame['brace_stack'].append((ch, line, col))
        elif ch in ')]}':
            if not frame['brace_stack']:
                print('unmatched', ch, line, col)
                break
            top, tl, tc = frame['brace_stack'][-1]
            pairs = {'(': ')', '[': ']', '{': '}'}
            if pairs[top] == ch:
                frame['brace_stack'].pop()
            else:
                print('mismatch', top, tl, tc, 'vs', ch, line, col)
                break
    elif frame['type'] == 'string':
        if frame['state'] == 'escape':
            frame['state'] = 'normal'
        elif ch == '\\':
            frame['state'] = 'escape'
        elif ch == frame['quote']:
            frames.pop()
    elif frame['type'] == 'template':
        if frame['state'] == 'escape':
            frame['state'] = 'normal'
        elif ch == '\\':
            frame['state'] = 'escape'
        elif ch == '`':
            frames.pop()
        elif ch == '$' and i+1 < len(text) and text[i+1] == '{':
            frames.append({'type': 'template_expr', 'brace_depth': 1, 'state': 'normal'})
            i += 1
            col += 1
    elif frame['type'] == 'template_expr':
        if frame['state'] == 'escape':
            frame['state'] = 'normal'
        elif ch == '\\':
            frame['state'] = 'escape'
        elif ch == '"':
            frames.append({'type': 'string', 'quote': '"', 'state': 'normal'})
        elif ch == "'":
            frames.append({'type': 'string', 'quote': "'", 'state': 'normal'})
        elif ch == '`':
            frames.append({'type': 'template', 'state': 'normal'})
        elif ch == '/':
            nxt = text[i+1] if i+1 < len(text) else ''
            if nxt == '/':
                frames.append({'type': 'line_comment', 'state': 'normal'})
                i += 1
                col += 1
            elif nxt == '*':
                frames.append({'type': 'block_comment', 'state': 'normal'})
                i += 1
                col += 1
        elif ch == '{':
            frame['brace_depth'] += 1
        elif ch == '}':
            frame['brace_depth'] -= 1
            if frame['brace_depth'] == 0:
                frames.pop()
    elif frame['type'] == 'line_comment':
        pass
    elif frame['type'] == 'block_comment':
        if ch == '*' and i+1 < len(text) and text[i+1] == '/':
            frames.pop()
            i += 1
            col += 1
    i += 1
else:
    print('finished normally')
print('frames:', [(f['type'], f.get('quote'), f.get('brace_depth'), f.get('state')) for f in frames])
