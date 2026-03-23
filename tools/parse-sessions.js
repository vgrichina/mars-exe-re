#!/usr/bin/env node
// Parse Claude Code session JSONL files and extract conversation narratives
// Usage: node parse-sessions.js [session-dir] [--summary | --narrative | --user-only | --commits]

const fs = require('fs');
const path = require('path');

const SESSION_DIR = process.argv[2] || path.join(
    process.env.HOME, '.claude/projects/-Users-vg-Documents-projects-phone-reverse-games-mars-exe'
);
const mode = process.argv[3] || '--summary';

function readSession(filepath) {
    const lines = fs.readFileSync(filepath, 'utf8').split('\n').filter(Boolean);
    const messages = [];
    for (const line of lines) {
        try {
            const obj = JSON.parse(line);
            messages.push(obj);
        } catch {}
    }
    return messages;
}

function extractText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(block => {
        if (block.type === 'text') return block.text;
        if (block.type === 'thinking') return null; // skip thinking
        if (block.type === 'tool_use') return `[TOOL: ${block.name}(${JSON.stringify(block.input).slice(0, 200)})]`;
        if (block.type === 'tool_result') {
            const txt = typeof block.content === 'string' ? block.content :
                Array.isArray(block.content) ? block.content.map(c => c.text || '').join('') : '';
            return `[RESULT: ${txt.slice(0, 300)}]`;
        }
        return '';
    }).filter(Boolean).join('\n');
}

function getSessionFiles() {
    return fs.readdirSync(SESSION_DIR)
        .filter(f => f.endsWith('.jsonl') && !f.includes('subagent'))
        .map(f => path.join(SESSION_DIR, f))
        .sort((a, b) => {
            const sa = fs.statSync(a).mtime;
            const sb = fs.statSync(b).mtime;
            return sa - sb;
        });
}

function summarizeSession(filepath) {
    const msgs = readSession(filepath);
    const id = path.basename(filepath, '.jsonl').slice(0, 8);
    let firstTs = null, lastTs = null;
    let userCount = 0, assistantCount = 0, toolUses = 0;
    let outputTokens = 0, cacheRead = 0, cacheCreate = 0;
    const userMessages = [];
    const toolNames = {};

    for (const msg of msgs) {
        const ts = msg.timestamp;
        if (ts) {
            if (!firstTs) firstTs = ts;
            lastTs = ts;
        }
        if (msg.type === 'user' && msg.message?.role === 'user') {
            userCount++;
            const txt = extractText(msg.message.content);
            if (txt && !txt.startsWith('<local-command') && !txt.startsWith('<command-name>')) {
                userMessages.push(txt.slice(0, 200));
            }
        }
        if (msg.type === 'assistant') {
            assistantCount++;
            const usage = msg.message?.usage;
            if (usage) {
                outputTokens += usage.output_tokens || 0;
                cacheRead += usage.cache_read_input_tokens || 0;
                cacheCreate += usage.cache_creation_input_tokens || 0;
            }
            const content = msg.message?.content;
            if (Array.isArray(content)) {
                for (const block of content) {
                    if (block.type === 'tool_use') {
                        toolUses++;
                        toolNames[block.name] = (toolNames[block.name] || 0) + 1;
                    }
                }
            }
        }
    }

    return {
        id, firstTs, lastTs, userCount, assistantCount,
        toolUses, outputTokens, cacheRead, cacheCreate,
        userMessages, toolNames,
        size: fs.statSync(filepath).size
    };
}

function narrativeSession(filepath) {
    const msgs = readSession(filepath);
    const id = path.basename(filepath, '.jsonl').slice(0, 8);
    const lines = [];

    for (const msg of msgs) {
        if (msg.type === 'user' && msg.message?.role === 'user') {
            const txt = extractText(msg.message.content);
            if (txt && !txt.startsWith('<local-command') && !txt.startsWith('<command-name>') && txt.length > 5) {
                lines.push(`\n### USER [${msg.timestamp?.slice(11, 19) || '??'}]\n${txt.slice(0, 1000)}`);
            }
        }
        if (msg.type === 'assistant') {
            const content = msg.message?.content;
            if (!Array.isArray(content)) continue;
            const parts = [];
            for (const block of content) {
                if (block.type === 'text' && block.text) parts.push(block.text.slice(0, 500));
                if (block.type === 'tool_use') {
                    if (block.name === 'Edit' || block.name === 'Write') {
                        parts.push(`[${block.name}: ${block.input?.file_path || '?'}]`);
                    } else if (block.name === 'Bash') {
                        parts.push(`[Bash: ${(block.input?.command || '').slice(0, 150)}]`);
                    } else if (block.name === 'Grep' || block.name === 'Glob') {
                        parts.push(`[${block.name}: ${block.input?.pattern || ''}]`);
                    }
                }
            }
            if (parts.length) {
                lines.push(`\n**Claude** [${msg.timestamp?.slice(11, 19) || '??'}]: ${parts.join(' | ')}`);
            }
        }
        // Tool results from system
        if (msg.type === 'tool_result' || (msg.type === 'system' && msg.subtype === 'tool_result')) {
            const txt = typeof msg.content === 'string' ? msg.content : '';
            if (txt.length > 10) {
                lines.push(`> Result: ${txt.slice(0, 200)}`);
            }
        }
    }

    return `# Session ${id}\n${lines.join('\n')}`;
}

function userOnlySession(filepath) {
    const msgs = readSession(filepath);
    const id = path.basename(filepath, '.jsonl').slice(0, 8);
    const lines = [`# Session ${id}`];

    for (const msg of msgs) {
        if (msg.type === 'user' && msg.message?.role === 'user') {
            const txt = extractText(msg.message.content);
            if (txt && !txt.startsWith('<local-command') && !txt.startsWith('<command-name>') && txt.length > 3) {
                lines.push(`[${msg.timestamp?.slice(0, 19) || '??'}] ${txt.slice(0, 500)}`);
            }
        }
    }
    return lines.join('\n');
}

// --- Main ---
const files = getSessionFiles();

if (mode === '--summary') {
    console.log('Session summaries:\n');
    for (const f of files) {
        const s = summarizeSession(f);
        const duration = s.firstTs && s.lastTs ?
            `${s.firstTs.slice(0, 16)} → ${s.lastTs.slice(11, 16)}` : '?';
        console.log(`## ${s.id} (${(s.size / 1024).toFixed(0)}KB)`);
        console.log(`   Time: ${duration}`);
        console.log(`   Messages: ${s.userCount} user / ${s.assistantCount} assistant`);
        console.log(`   Tools: ${s.toolUses} calls — ${Object.entries(s.toolNames).map(([k,v]) => `${k}:${v}`).join(', ')}`);
        console.log(`   Tokens: ${s.outputTokens} out, ${(s.cacheRead/1e6).toFixed(1)}M cache-read`);
        console.log(`   User topics: ${s.userMessages.slice(0, 5).map(m => m.slice(0, 80)).join(' | ')}`);
        console.log('');
    }
} else if (mode === '--narrative') {
    const idx = process.argv[4] ? parseInt(process.argv[4]) : -1;
    if (idx >= 0 && idx < files.length) {
        console.log(narrativeSession(files[idx]));
    } else {
        for (let i = 0; i < files.length; i++) {
            console.log(`\n${'='.repeat(60)}\n`);
            console.log(narrativeSession(files[i]));
        }
    }
} else if (mode === '--user-only') {
    const idx = process.argv[4] ? parseInt(process.argv[4]) : -1;
    if (idx >= 0 && idx < files.length) {
        console.log(userOnlySession(files[idx]));
    } else {
        for (const f of files) {
            console.log(userOnlySession(f));
            console.log('\n---\n');
        }
    }
} else if (mode === '--commits') {
    // Cross-reference git commits with session timestamps
    const { execSync } = require('child_process');
    const log = execSync('git log --format="%aI|%s" --reverse', { encoding: 'utf8' });
    for (const line of log.trim().split('\n')) {
        const [ts, ...msg] = line.split('|');
        console.log(`${ts.slice(0, 16)} ${msg.join('|')}`);
    }
}
