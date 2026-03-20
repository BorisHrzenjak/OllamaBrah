// proxy/skills.js — skill loading, watching, copying, GitHub import, skill endpoints

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Resolve paths that may live in app.asar.unpacked when packaged
function unpackedPath(...segments) {
    const base = __dirname.includes('app.asar')
        ? __dirname.replace('app.asar', 'app.asar.unpacked')
        : __dirname;
    return path.join(base, ...segments);
}

// ── Skills ────────────────────────────────────────────────────────────────────

const BUILTIN_SKILLS_DIR = path.join(__dirname, '..', 'resources', 'skills');
let loadedSkills = []; // [{ name, description, builtin, dir }]

function parseSkillFrontmatter(md) {
    const parts = md.split(/^---\s*$/m);
    if (parts.length < 3) return {};
    const meta = {};
    for (const line of parts[1].split('\n')) {
        const m = line.match(/^(\w+):\s*(.+)$/);
        if (m) meta[m[1]] = m[2].trim();
    }
    return meta;
}

function loadSkillsMetadata() {
    const skillsDir = process.env.SKILLS_DIR;
    if (!skillsDir || !fs.existsSync(skillsDir)) return [];
    const result = [];
    try {
        const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            const mdPath = path.join(skillsDir, e.name, 'SKILL.md');
            if (!fs.existsSync(mdPath)) continue;
            try {
                const md = fs.readFileSync(mdPath, 'utf8');
                const meta = parseSkillFrontmatter(md);
                if (meta.name) {
                    result.push({
                        name: meta.name,
                        description: meta.description || '',
                        builtin: meta.builtin === 'true',
                        dir: path.join(skillsDir, e.name),
                    });
                }
            } catch {}
        }
    } catch {}
    return result;
}

function reloadSkills() {
    const newSkills = loadSkillsMetadata();
    loadedSkills.splice(0, loadedSkills.length, ...newSkills);
    console.log(`[Skills] Loaded ${loadedSkills.length} skill(s):`, loadedSkills.map(s => s.name).join(', ') || '(none)');
}

function copyBuiltinSkills() {
    const skillsDir = process.env.SKILLS_DIR;
    if (!skillsDir) return;
    fs.mkdirSync(skillsDir, { recursive: true });
    if (!fs.existsSync(BUILTIN_SKILLS_DIR)) return;
    try {
        const builtins = fs.readdirSync(BUILTIN_SKILLS_DIR, { withFileTypes: true });
        for (const e of builtins) {
            if (!e.isDirectory()) continue;
            const dest = path.join(skillsDir, e.name);
            if (!fs.existsSync(dest)) {
                try {
                    fs.cpSync(path.join(BUILTIN_SKILLS_DIR, e.name), dest, { recursive: true });
                    console.log(`[Skills] Copied built-in skill: ${e.name}`);
                } catch (err) {
                    console.warn(`[Skills] Failed to copy ${e.name}:`, err.message);
                }
            }
        }
    } catch (err) {
        console.warn('[Skills] copyBuiltinSkills failed:', err.message);
    }
}

async function githubGet(url) {
    const resp = await fetch(url, {
        headers: { 'User-Agent': 'OllamaBrah/1.0', 'Accept': 'application/vnd.github.v3+json' }
    });
    return resp;
}

async function downloadGitHubDir(owner, repo, branch, dirPath, destDir) {
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}?ref=${branch}`;
    const resp = await githubGet(apiUrl);
    if (!resp.ok) {
        // On 404 for a specific sub-path, list the repo root to give a helpful error
        if (resp.status === 404 && dirPath) {
            let hint = '';
            try {
                const rootResp = await githubGet(`https://api.github.com/repos/${owner}/${repo}/contents/?ref=${branch}`);
                if (rootResp.ok) {
                    const rootItems = await rootResp.json();
                    if (Array.isArray(rootItems)) {
                        const dirs = rootItems.filter(i => i.type === 'dir').map(i => i.name);
                        if (dirs.length) hint = ` Available top-level folders: ${dirs.join(', ')}`;
                    }
                }
            } catch {}
            throw new Error(`Path "${dirPath}" not found in ${owner}/${repo} (branch: ${branch}).${hint}`);
        }
        const body = await resp.text().catch(() => '');
        throw new Error(`GitHub API ${resp.status}: ${body.slice(0, 200) || resp.statusText}`);
    }
    const items = await resp.json();
    if (!Array.isArray(items)) throw new Error('Expected a directory at that URL, got a single file or unexpected response');
    fs.mkdirSync(destDir, { recursive: true });
    for (const item of items) {
        const itemDest = path.join(destDir, item.name);
        if (item.type === 'file') {
            const fileResp = await fetch(item.download_url);
            if (!fileResp.ok) throw new Error(`Failed to download ${item.name}: HTTP ${fileResp.status}`);
            const content = await fileResp.arrayBuffer();
            fs.writeFileSync(itemDest, Buffer.from(content));
        } else if (item.type === 'dir') {
            await downloadGitHubDir(owner, repo, branch, item.path, itemDest);
        }
    }
}

// Parse any of:
//   https://github.com/owner/repo/tree/branch/path   (GitHub URL)
//   npx skills add <url-or-id> --skill name -g -y    (full npx command — paste-friendly)
//   owner/repo@skill                                  (short package id)
//   owner/repo/skill                                  (slash form)
//   owner/repo                                        (whole repo)
function parseSkillSource(input) {
    let s = input.trim();

    // Extract --skill <value> FIRST before any other stripping, e.g. "--skill brains"
    let namedSkill = null;
    const skillFlagMatch = s.match(/--skill\s+(\S+)/i);
    if (skillFlagMatch) {
        namedSkill = skillFlagMatch[1];
        s = s.replace(/\s*--skill\s+\S+/i, '');
    }

    // Strip "npx skills add" prefix
    s = s.replace(/^npx\s+skills\s+add\s+/i, '');

    // Strip remaining boolean flags: -g -y --global --yes (no value after them)
    s = s.replace(/\s+--?[\w-]+/g, '').trim();

    // GitHub URL — note [^/\s] to reject spaces in owner/repo
    const ghUrl = s.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)(?:\/tree\/([^/\s]+)(?:\/([^\s]+?))?)?(?:\/?)$/);
    if (ghUrl) {
        const [, owner, repo, branch = 'main', urlSkillPath = ''] = ghUrl;
        return { owner, repo, branch, skillPath: namedSkill || urlSkillPath };
    }

    // owner/repo@skill
    const atForm = s.match(/^([^/\s@]+)\/([^@/\s]+)@([^\s]+)$/);
    if (atForm) return { owner: atForm[1], repo: atForm[2], branch: 'main', skillPath: namedSkill || atForm[3] };

    // owner/repo/skill
    const slashForm = s.match(/^([^/\s]+)\/([^/\s]+)\/([^\s]+)$/);
    if (slashForm) return { owner: slashForm[1], repo: slashForm[2], branch: 'main', skillPath: namedSkill || slashForm[3] };

    // owner/repo
    const repoForm = s.match(/^([^/\s]+)\/([^/\s]+)$/);
    if (repoForm) return { owner: repoForm[1], repo: repoForm[2], branch: 'main', skillPath: namedSkill || '' };

    return null;
}

// --- Route handlers ---

function handleSkillsList(req, res) {
    res.json(loadedSkills.map(s => ({ name: s.name, description: s.description, builtin: s.builtin })));
}

function handleSkillsReload(req, res) {
    reloadSkills();
    res.json({ ok: true, count: loadedSkills.length });
}

function handleSkillsImport(req, res) {
    const { sourcePath } = req.body || {};
    if (!sourcePath || !fs.existsSync(sourcePath)) {
        return res.status(400).json({ error: 'Invalid or missing source path' });
    }
    const skillsDir = process.env.SKILLS_DIR;
    if (!skillsDir) return res.status(500).json({ error: 'SKILLS_DIR not configured' });
    const skillName = path.basename(sourcePath);
    const dest = path.join(skillsDir, skillName);
    try {
        fs.cpSync(sourcePath, dest, { recursive: true });
        reloadSkills();
        res.json({ ok: true, name: skillName });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

async function handleSkillsImportUrl(req, res) {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'URL or package identifier required' });

    const parsed = parseSkillSource(url);
    if (!parsed) {
        return res.status(400).json({
            error: 'Could not parse input. Accepted formats:\n' +
                   '  • https://github.com/owner/repo/tree/main/skill-name\n' +
                   '  • owner/repo@skill-name\n' +
                   '  • npx skills add owner/repo@skill-name -g -y'
        });
    }

    let { owner, repo, branch, skillPath } = parsed;
    const skillName = skillPath ? path.basename(skillPath) : repo;
    const skillsDir = process.env.SKILLS_DIR;
    if (!skillsDir) return res.status(500).json({ error: 'SKILLS_DIR not configured' });

    // If branch was not explicitly in the URL, resolve the repo's actual default branch
    // (avoids main vs master mismatch)
    if (branch === 'main') {
        try {
            const repoResp = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
                headers: { 'User-Agent': 'OllamaBrah/1.0', 'Accept': 'application/vnd.github.v3+json' }
            });
            if (repoResp.ok) {
                const repoData = await repoResp.json();
                if (repoData.default_branch) branch = repoData.default_branch;
            }
        } catch {}
    }

    const dest = path.join(skillsDir, skillName);
    try {
        await downloadGitHubDir(owner, repo, branch, skillPath, dest);
        reloadSkills();
        res.json({ ok: true, name: skillName });
    } catch (err) {
        console.error('[Skills] import-url failed:', err.message);
        res.status(500).json({ error: err.message });
    }
}

function handleSkillsDelete(req, res) {
    const { name } = req.params;
    const skillsDir = process.env.SKILLS_DIR;
    if (!skillsDir) return res.status(500).json({ error: 'SKILLS_DIR not configured' });
    const skillDir = path.join(skillsDir, name);
    try {
        fs.rmSync(skillDir, { recursive: true, force: true });
        reloadSkills();
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

function handleSkillsDir(req, res) {
    res.json({ dir: process.env.SKILLS_DIR || null });
}

// Run `npx skills add ...` as a child process with SKILLS_DIR set.
// Streams stdout/stderr lines as NDJSON so the UI can show live output.
function handleSkillsRunCli(req, res) {
    const { command } = req.body || {};
    if (!command || typeof command !== 'string') {
        return res.status(400).json({ error: 'command required' });
    }

    const skillsDir = process.env.SKILLS_DIR;
    if (!skillsDir) return res.status(500).json({ error: 'SKILLS_DIR not configured' });

    // Only allow npx skills add commands
    const trimmed = command.trim();
    if (!/^npx\s+skills\s+add\b/i.test(trimmed)) {
        return res.status(400).json({ error: 'Only "npx skills add ..." commands are allowed here.' });
    }

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');

    const childEnv = {
        ...process.env,
        SKILLS_DIR: skillsDir,
        CLAUDE_SKILLS_DIR: skillsDir,   // some CLI variants use this name
        SKILL_OUTPUT_DIR: skillsDir,
    };

    const proc = spawn(trimmed, {
        shell: true,
        cwd: skillsDir,
        env: childEnv,
        timeout: 120000,
    });

    const write = (type, text) => {
        if (!res.writableEnded) res.write(JSON.stringify({ type, text }) + '\n');
    };

    proc.stdout.on('data', d => write('stdout', d.toString()));
    proc.stderr.on('data', d => write('stderr', d.toString()));

    proc.on('close', (code) => {
        reloadSkills();
        write('exit', `Process exited with code ${code}`);
        write('skills', JSON.stringify(loadedSkills.map(s => ({ name: s.name, description: s.description, builtin: s.builtin }))));
        if (!res.writableEnded) res.end();
    });

    proc.on('error', (err) => {
        write('error', err.message);
        if (!res.writableEnded) res.end();
    });

    res.on('close', () => { if (!proc.killed) proc.kill(); });
}

module.exports = {
    BUILTIN_SKILLS_DIR,
    loadedSkills,
    parseSkillFrontmatter,
    loadSkillsMetadata,
    reloadSkills,
    copyBuiltinSkills,
    githubGet,
    downloadGitHubDir,
    parseSkillSource,
    handleSkillsList,
    handleSkillsReload,
    handleSkillsImport,
    handleSkillsImportUrl,
    handleSkillsDelete,
    handleSkillsDir,
    handleSkillsRunCli,
};
