import { promises as fsp } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'pathe'
import type { Nuxt, TSReference } from '@nuxt/schema'
import { defu } from 'defu'
import type { TSConfig } from 'pkg-types'
import { getModulePaths, getNearestPackage } from './cjs'

export const writeTypes = async (nuxt: Nuxt) => {
  const modulePaths = getModulePaths(nuxt.options.modulesDir)

  const tsConfig: TSConfig = defu(nuxt.options.typescript?.tsConfig, {
    compilerOptions: {
      forceConsistentCasingInFileNames: true,
      jsx: 'preserve',
      target: 'ESNext',
      module: 'ESNext',
      moduleResolution: 'Node',
      skipLibCheck: true,
      strict: nuxt.options.typescript?.strict ?? false,
      allowJs: true,
      noEmit: true,
      resolveJsonModule: true,
      allowSyntheticDefaultImports: true,
      types: ['node'],
      paths: {}
    },
    include: [
      './nuxt.d.ts',
      join(relative(nuxt.options.buildDir, nuxt.options.rootDir), '**/*'),
      ...nuxt.options.srcDir !== nuxt.options.rootDir ? [join(relative(nuxt.options.buildDir, nuxt.options.srcDir), '**/*')] : [],
      ...nuxt.options.typescript.includeWorkspace && nuxt.options.workspaceDir !== nuxt.options.rootDir ? [join(relative(nuxt.options.buildDir, nuxt.options.workspaceDir), '**/*')] : []
    ],
    exclude: [
      // nitro generate output: https://github.com/nuxt/nuxt/blob/main/packages/nuxt/src/core/nitro.ts#L186
      relative(nuxt.options.buildDir, resolve(nuxt.options.rootDir, 'dist'))
    ]
  })

  const aliases: Record<string, string> = {
    ...nuxt.options.alias,
    '#build': nuxt.options.buildDir
  }

  // Exclude bridge alias types to support Volar
  const excludedAlias = [/^@vue\/.*$/]

  const basePath = tsConfig.compilerOptions!.baseUrl || nuxt.options.buildDir

  for (const alias in aliases) {
    if (excludedAlias.some(re => re.test(alias))) {
      continue
    }
    const relativePath = isAbsolute(aliases[alias])
      ? withLeadingDot(relative(basePath, aliases[alias]) || '.')
      : aliases[alias]

    const stats = await fsp.stat(resolve(basePath, relativePath)).catch(() => null /* file does not exist */)
    tsConfig.compilerOptions = tsConfig.compilerOptions || {}
    if (stats?.isDirectory()) {
      tsConfig.compilerOptions.paths[alias] = [relativePath]
      tsConfig.compilerOptions.paths[`${alias}/*`] = [`${relativePath}/*`]
    } else {
      tsConfig.compilerOptions.paths[alias] = [relativePath.replace(/(?<=\w)\.\w+$/g, '')] /* remove extension */
    }
  }

  const references: TSReference[] = [
    ...nuxt.options.modules,
    ...nuxt.options._modules
  ]
    .filter(f => typeof f === 'string')
    .map(id => ({ types: getNearestPackage(id, modulePaths)?.name || id }))

  if (nuxt.options.experimental?.reactivityTransform) {
    references.push({ types: 'vue/macros-global' })
  }

  const declarations: string[] = []

  await nuxt.callHook('prepare:types', { references, declarations, tsConfig })

  const declaration = [
    ...references.map((ref) => {
      if ('path' in ref && isAbsolute(ref.path)) {
        ref.path = relative(nuxt.options.buildDir, ref.path)
      }
      return `/// <reference ${renderAttrs(ref)} />`
    }),
    ...declarations,
    '',
    'export {}',
    ''
  ].join('\n')

  async function writeFile () {
    const GeneratedBy = '// Generated by nuxi'

    const tsConfigPath = resolve(nuxt.options.buildDir, 'tsconfig.json')
    await fsp.mkdir(nuxt.options.buildDir, { recursive: true })
    await fsp.writeFile(tsConfigPath, GeneratedBy + '\n' + JSON.stringify(tsConfig, null, 2))

    const declarationPath = resolve(nuxt.options.buildDir, 'nuxt.d.ts')
    await fsp.writeFile(declarationPath, GeneratedBy + '\n' + declaration)
  }

  // This is needed for Nuxt 2 which clears the build directory again before building
  // https://github.com/nuxt/nuxt/blob/2.x/packages/builder/src/builder.js#L144
  // @ts-expect-error TODO: Nuxt 2 hook
  nuxt.hook('builder:prepared', writeFile)

  await writeFile()
}

const LEADING_DOT_RE = /^\.{1,2}(\/|$)/
function withLeadingDot (path: string) {
  if (LEADING_DOT_RE.test(path)) {
    return path
  }
  return `./${path}`
}

function renderAttrs (obj: Record<string, string>) {
  return Object.entries(obj).map(e => renderAttr(e[0], e[1])).join(' ')
}

function renderAttr (key: string, value: string) {
  return value ? `${key}="${value}"` : ''
}
