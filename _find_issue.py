"""Check brace balance in index.ts, properly handling strings and template literals."""
import re

with open('extensions/pi-agile/index.ts', 'r', encoding='utf8') as f:
    text = f.read()

# Find location of delegateBatchParallel function
fn_idx = text.index('async function delegateBatchParallel')
# Find the function body opening brace (after Promise<{...}>)
body_start = text.index('}> {', fn_idx) + 4

line_num = text[:body_start].count('\n') + 1
print(f'Function body starts at line {line_num}')

depth = 0
i = body_start
in_string = False
string_char = None
in_template = False
template_depth = 0
last_line = line_num

while i < len(text):
    # Stop at executeBatchTasks (next function)
    if text[i:i+30] == 'async function executeBatchTasks':
        break
    
    c = text[i]
    prev = text[i-1] if i > 0 else ''
    
    # Track newlines for reporting
    if c == '\n':
        last_line += 1
        i += 1
        continue
    
    # Skip single-line comments
    if c == '/' and i+1 < len(text) and text[i+1] == '/':
        while i < len(text) and text[i] != '\n':
            i += 1
        continue
    
    # Skip block comments
    if c == '/' and i+1 < len(text) and text[i+1] == '*':
        i += 2
        while i < len(text) and not (text[i] == '*' and i+1 < len(text) and text[i+1] == '/'):
            if text[i] == '\n': last_line += 1
            i += 1
        i += 2  # skip */
        continue
    
    # Handle strings
    if not in_template and (c == "'" or c == '"') and prev != '\\':
        if not in_string:
            in_string = True
            string_char = c
        elif c == string_char:
            in_string = False
        i += 1
        continue
    if in_string:
        i += 1
        continue
    
    # Handle template literals
    if c == '`' and prev != '\\':
        if not in_template:
            in_template = True
            template_depth = 0
        elif template_depth == 0:
            in_template = False
        i += 1
        continue
    
    if in_template:
        if c == '$' and i+1 < len(text) and text[i+1] == '{':
            template_depth += 1
            i += 2
            continue
        if c == '}':
            if template_depth > 0:
                template_depth -= 1
            i += 1
            continue
        i += 1
        continue
    
    # Count braces
    if c == '{':
        depth += 1
    elif c == '}':
        depth -= 1
        if depth == 0:
            print(f'Function closes at line {last_line}, after function body start')
            # Show context
            start = max(body_start, i - 60)
            end = min(len(text), i + 20)
            print(f'Context: {repr(text[start:end])}')
            break
    
    i += 1

if depth > 0:
    print(f'Function NEVER closes! End depth: {depth}, near line {last_line}')
elif depth < 0:
    print(f'Extra closing brace at line {last_line}!')
