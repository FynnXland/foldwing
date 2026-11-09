// Erzeugt THIRD-PARTY-NOTICES.md: alles, was mit Foldwing ausgeliefert wird,
// mit Version, Lizenz und Quelle.
//
//   - Bibliotheken im app.asar: jedes Paket aus package-lock.json ohne
//     "dev": true (electron-builder packt genau die Produktions-Abhängigkeiten ein)
//   - in die Oberfläche gebündelt: react, react-dom, scheduler (Vite)
//   - Electron, cloudflared (Version aus scripts/fetch-cloudflared.mjs) und die
//     Schriften Geist und Geist Mono
//
// Fehlt im Lockfile eine Lizenzangabe, gilt die aus node_modules/<paket>/package.json.
// Steht eine Lizenz nicht auf der Liste freizügiger Lizenzen (etwa GPL), bricht das
// Skript ab: Foldwing steht unter MIT, so etwas gehört nicht ins Paket.
//
// Aufruf: node scripts/third-party-notices.mjs           schreibt die Datei neu
//         node scripts/third-party-notices.mjs --check   prüft nur, ob sie aktuell ist
// Voraussetzung: node_modules passt zum Lockfile (npm ci).
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'THIRD-PARTY-NOTICES.md')

/** Freizügige Lizenzen, die mit einer MIT-lizenzierten App verträglich sind. */
const PERMISSIVE = new Set([
  'MIT',
  'ISC',
  '0BSD',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'Zlib',
  'Python-2.0',
  'BlueOak-1.0.0',
  'CC0-1.0'
])

/** Erklärung für weniger bekannte Lizenzen (landet in den Hinweisen). */
const LICENSE_EXPLAINED = {
  'Python-2.0': 'the Python Software Foundation License 2.0, a permissive license',
  'BlueOak-1.0.0': 'the Blue Oak Model License 1.0.0, a permissive license',
  Zlib: 'the zlib License, a permissive license'
}

/**
 * Von Hand geprüfte Angaben, wo package.json unklar ist. Der Schlüssel enthält die
 * Version: Nach einem Update muss die neue Version erneut geprüft werden.
 */
const LICENSE_OVERRIDES = {
  'duck@0.1.12': {
    license: 'BSD-2-Clause',
    note: 'declares only "BSD" in its package.json; its license file is the 2-clause BSD license'
  }
}

/** Von Vite in die Oberfläche (src/renderer) gebündelte Pakete. */
const RENDERER_PACKAGES = ['react', 'react-dom', 'scheduler']

/**
 * Schriften in resources/fonts (Freigabe-Seiten) und src/renderer/src/fonts
 * (Oberfläche). Die Version steht in der name-Tabelle der WOFF2-Dateien; Copyright
 * und Lizenz fehlen dort, deshalb steht der Lizenztext unten vollständig. Der
 * SHA256 bindet die Angaben an genau diese Dateien: Wer eine Schrift austauscht,
 * muss Version und Lizenz hier neu prüfen.
 */
const FONTS = [
  {
    name: 'Geist (font)',
    version: '1.200',
    file: 'Geist-Variable.woff2',
    sha256: '28258d0621216948416a859d32487ab6ad1c9effa0d08795698e70be3c917630'
  },
  {
    name: 'Geist Mono (font)',
    version: '1.200',
    file: 'GeistMono-Variable.woff2',
    sha256: '5bc6413e82be410dc057feccee55160495b999d0fe212b7b6c6499b29b8b1e4a'
  }
]
const FONT_DIRS = ['resources/fonts', 'src/renderer/src/fonts']
const FONT_SOURCE = 'https://github.com/vercel/geist-font'

// Wortgetreu aus https://github.com/vercel/geist-font/blob/main/LICENSE.txt
const GEIST_LICENSE = `Copyright (c) 2023 Vercel, in collaboration with basement.studio

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION AND CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.`

// Wortgetreu aus https://github.com/cloudflare/cloudflared/blob/2026.8.3/LICENSE
const APACHE_2_0 = `                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.`

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function compareVersions(a, b) {
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i] ?? 0)
    const nb = Number(pb[i] ?? 0)
    if (Number.isNaN(na) || Number.isNaN(nb)) return cmp(a, b)
    if (na !== nb) return na - nb
  }
  return 0
}

/** "node_modules/a/node_modules/@s/b" -> "@s/b" */
function packageName(lockPath) {
  const marker = 'node_modules/'
  return lockPath.slice(lockPath.lastIndexOf(marker) + marker.length)
}

/** Link zum Quell-Repository, sonst zur npm-Seite. */
function sourceUrl(pkg, name) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  if (repo) {
    const short = repo.match(/^(?:github:)?([\w.-]+)\/([\w.-]+)$/)
    if (short) return `https://github.com/${short[1]}/${short[2].replace(/\.git$/, '')}`
    const github = repo.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
    if (github) return `https://github.com/${github[1]}/${github[2]}`
    // Andere Hoster (z. B. git.sheetjs.com): https-Adresse ohne `git+` und `.git`
    const other = repo.match(/^(?:git\+)?(https:\/\/[^\s]+?)(?:\.git)?\/?$/)
    if (other) return other[1]
  }
  return `https://www.npmjs.com/package/${name}`
}

/** Einfacher SPDX-Ausdruck: "X", "(X OR Y)" oder "(X AND Y)". Alles andere: null. */
function parseExpression(expr) {
  const text = expr.trim().replace(/^\((.*)\)$/, '$1').trim()
  if (!text || /[()]/.test(text) || (text.includes(' OR ') && text.includes(' AND '))) return null
  for (const op of ['OR', 'AND']) {
    if (text.includes(` ${op} `)) return { text, op, ids: text.split(` ${op} `).map((s) => s.trim()) }
  }
  return { text, op: null, ids: [text] }
}

/** Prüft die Lizenz; `usedUnder` ist die Lizenz, unter der Foldwing das Paket nutzt. */
function checkLicense(label, raw, problems) {
  const parsed = typeof raw === 'string' ? parseExpression(raw) : null
  if (!parsed) {
    problems.push(`${label}: Lizenzangabe „${raw ?? 'fehlt'}“ von Hand prüfen`)
    return { text: String(raw ?? 'unknown'), ids: [], usedUnder: null }
  }
  if (parsed.op === 'OR') {
    const chosen = parsed.ids.find((id) => PERMISSIVE.has(id))
    if (!chosen) problems.push(`${label}: keine freizügige Wahl in „${parsed.text}“`)
    return { ...parsed, usedUnder: chosen ?? null }
  }
  const bad = parsed.ids.filter((id) => !PERMISSIVE.has(id))
  if (bad.length) problems.push(`${label}: „${bad.join(', ')}“ ist keine freizügige Lizenz`)
  return { ...parsed, usedUnder: parsed.text }
}

function describePackage(lockPath, info, problems) {
  const name = packageName(lockPath)
  const dir = join(ROOT, ...lockPath.split('/'))
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) {
    problems.push(`${lockPath} fehlt – erst \`npm ci\` ausführen`)
    return null
  }
  const pkg = readJson(pkgPath)
  const version = info.version ?? pkg.version
  const label = `${name}@${version}`
  const override = LICENSE_OVERRIDES[label]
  const legacy = Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type).join(' OR ') : undefined
  const raw = override?.license ?? info.license ?? pkg.license ?? legacy
  return {
    name,
    version,
    license: checkLicense(label, raw, problems),
    source: sourceUrl(pkg, name),
    note: override?.note ?? null,
    hasLicenseFile: readdirSync(dir).some((f) => /^(licen[cs]e|copying)/i.test(f)),
    dir
  }
}

function cloudflaredVersion() {
  const text = readFileSync(join(ROOT, 'scripts', 'fetch-cloudflared.mjs'), 'utf8')
  const m = text.match(/^const VERSION = '([^']+)'/m)
  if (!m) throw new Error('VERSION in scripts/fetch-cloudflared.mjs nicht gefunden')
  return m[1]
}

function collect() {
  const lock = readJson(join(ROOT, 'package-lock.json'))
  const pkg = readJson(join(ROOT, 'package.json'))
  const problems = []

  const asar = []
  for (const [lockPath, info] of Object.entries(lock.packages)) {
    if (!lockPath.startsWith('node_modules/') || info.dev || info.link) continue
    const entry = describePackage(lockPath, info, problems)
    if (entry) asar.push(entry)
  }
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (!asar.some((p) => p.name === dep)) problems.push(`Abhängigkeit ${dep} fehlt im Lockfile`)
  }

  const renderer = []
  for (const name of RENDERER_PACKAGES) {
    const info = lock.packages[`node_modules/${name}`]
    if (!info) {
      problems.push(`${name} fehlt im Lockfile`)
      continue
    }
    const entry = describePackage(`node_modules/${name}`, info, problems)
    if (entry) renderer.push(entry)
  }

  const electron = lock.packages['node_modules/electron']
  if (!electron) problems.push('electron fehlt im Lockfile')

  const known = new Set(FONTS.map((f) => f.file))
  for (const dir of FONT_DIRS) {
    const present = existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir)) : []
    for (const file of present.filter((f) => /\.(woff2?|ttf|otf)$/i.test(f) && !known.has(f))) {
      problems.push(`${dir}/${file}: unbekannte Schrift – in FONTS mit Version, Lizenz und SHA256 eintragen`)
    }
    for (const font of FONTS) {
      const path = join(ROOT, dir, font.file)
      const actual = existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null
      if (actual !== font.sha256) {
        problems.push(`${dir}/${font.file}: fehlt oder wurde ausgetauscht – Version und Lizenz in FONTS prüfen`)
      }
    }
  }

  const byName =(a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase()) || compareVersions(a.version, b.version)
  asar.sort(byName)

  return { asar, renderer, electronVersion: electron?.version, cloudflared: cloudflaredVersion(), problems }
}

function table(header, rows) {
  return [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`)
  ]
}

function codeBlock(text) {
  return ['```text', text.replace(/^\n+|\s+$/g, ''), '```']
}

function render({ asar, renderer, electronVersion, cloudflared }) {
  const npmPackages = [...renderer, ...asar]
  const out = []
  out.push(
    '# Third-party components',
    '',
    "Foldwing's own source code is licensed under the [MIT License](LICENSE). The packaged app",
    '(Windows installer and portable app, Linux AppImage and .deb) also contains the components',
    "listed below. They keep their own licenses; nothing in Foldwing's license changes their terms.",
    '',
    'This file is generated by `scripts/third-party-notices.mjs` from `package-lock.json`. Do not',
    'edit it by hand: run `node scripts/third-party-notices.mjs` after changing dependencies, the',
    'cloudflared version or the fonts.',
    '',
    '## Programs and fonts',
    '',
    ...table(
      ['Component', 'Version', 'License', 'Source'],
      [
        ['Electron (contains Chromium and Node.js)', electronVersion, 'MIT', 'https://github.com/electron/electron'],
        ['cloudflared (unmodified program from Cloudflare)', cloudflared, 'Apache-2.0', 'https://github.com/cloudflare/cloudflared'],
        ...FONTS.map((f) => [f.name, f.version, 'OFL-1.1', FONT_SOURCE])
      ]
    ),
    '',
    "Electron's license and the licenses of Chromium and its components are installed with the",
    'app as `LICENSE.electron.txt` and `LICENSES.chromium.html`, next to the program file.',
    'cloudflared is a Go program; the Go modules compiled into it and their license files are in',
    'the `vendor/` folder of its source repository.',
    '',
    '## Built into the user interface',
    '',
    'Vite compiles these packages into the user interface inside `resources/app.asar`.',
    '',
    ...table(
      ['Package', 'Version', 'License', 'Source'],
      renderer.map((p) => [p.name, p.version, p.license.text, p.source])
    ),
    '',
    '## Libraries in the app archive',
    '',
    'electron-builder packs every production dependency from `package-lock.json` into',
    '`resources/app.asar`. The license files of these packages are included there under',
    '`node_modules/<package>/`.',
    '',
    ...table(
      ['Package', 'Version', 'License', 'Source'],
      asar.map((p) => [p.name, p.version, p.license.text, p.source])
    ),
    ''
  )

  // Übersicht: unter welcher Lizenz Foldwing die npm-Pakete nutzt.
  const counts = new Map()
  for (const p of npmPackages) counts.set(p.license.usedUnder, (counts.get(p.license.usedUnder) ?? 0) + 1)
  const countRows = [...counts.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))

  const notes = []
  for (const p of npmPackages) {
    if (p.license.op === 'OR') {
      notes.push(
        `- **${p.name}** ${p.version} is dual-licensed (${p.license.text}). Foldwing uses it under ${p.license.usedUnder}.`
      )
    }
  }
  for (const p of npmPackages) {
    for (const id of p.license.ids) {
      if (LICENSE_EXPLAINED[id]) notes.push(`- **${p.name}** ${p.version}: \`${id}\` is ${LICENSE_EXPLAINED[id]}.`)
    }
  }
  for (const p of npmPackages) if (p.note) notes.push(`- **${p.name}** ${p.version} ${p.note}.`)
  const withoutFile = asar.filter((p) => !p.hasLicenseFile)
  if (withoutFile.length) {
    notes.push(
      '- These packages contain no license file; their license comes from their package.json: ' +
        withoutFile.map((p) => `**${p.name}** ${p.version} (${p.license.text})`).join(', ') +
        '.'
    )
  }

  out.push(
    '## License compatibility',
    '',
    'Foldwing is distributed under the MIT License. Every npm package above is used under one',
    'of these permissive licenses:',
    '',
    ...table(['License', 'Packages'], countRows.map(([license, n]) => [license, String(n)])),
    ''
  )
  if (notes.length) out.push(...notes, '')
  out.push(
    'cloudflared (Apache-2.0) ships as a separate, unmodified program, and the SIL Open Font',
    'License allows the Geist fonts to be bundled with any software. None of these components is',
    'used under the GPL or the LGPL; `scripts/third-party-notices.mjs` stops with an error when',
    "an npm package's license is not on its list of permissive licenses.",
    '',
    'Electron itself is licensed under MIT. The Chromium inside it contains components under',
    'further licenses, among them LGPL-licensed parts such as the FFmpeg library, which Electron',
    'ships as a separate file (`ffmpeg.dll`, on Linux `libffmpeg.so`). All of them are listed in',
    '`LICENSES.chromium.html`.',
    ''
  )

  // Lizenztexte, die sonst nirgends im Paket liegen.
  out.push(
    '## License texts',
    '',
    'These components would otherwise ship without their license text: React is compiled into',
    'the user interface without its license file, the font files carry no license information,',
    'and cloudflared ships as a bare program file.',
    ''
  )
  const groups = new Map()
  for (const p of renderer) {
    const file = readdirSync(p.dir).find((f) => /^licen[cs]e/i.test(f))
    const text = file ? readFileSync(join(p.dir, file), 'utf8').replace(/\r\n/g, '\n') : ''
    if (!groups.has(text)) groups.set(text, [])
    groups.get(text).push(p)
  }
  for (const [text, pkgs] of groups) {
    if (!text) continue
    const license = pkgs[0].license.text === 'MIT' ? 'MIT License' : pkgs[0].license.text
    out.push(`### ${pkgs.map((p) => p.name).join(', ')}: ${license}`, '', ...codeBlock(text), '')
  }
  out.push('### Geist, Geist Mono: SIL Open Font License 1.1', '', ...codeBlock(GEIST_LICENSE), '')
  out.push('### cloudflared: Apache License 2.0', '', ...codeBlock(APACHE_2_0))

  return out.join('\n') + '\n'
}

const data = collect()
if (data.problems.length) {
  console.error('[Foldwing] THIRD-PARTY-NOTICES.md nicht erzeugt:')
  for (const p of data.problems) console.error(`  - ${p}`)
  process.exit(1)
}
const content = render(data)

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : ''
  if (current !== content) {
    console.error(
      '[Foldwing] THIRD-PARTY-NOTICES.md ist nicht aktuell. `node scripts/third-party-notices.mjs` ausführen.'
    )
    process.exit(1)
  }
  console.log('[Foldwing] THIRD-PARTY-NOTICES.md ist aktuell.')
} else {
  writeFileSync(OUT, content)
  console.log(
    `[Foldwing] THIRD-PARTY-NOTICES.md geschrieben: ${data.asar.length} Bibliotheken im app.asar, ` +
      `${data.renderer.length} in der Oberfläche, Electron, cloudflared, Schriften.`
  )
}
