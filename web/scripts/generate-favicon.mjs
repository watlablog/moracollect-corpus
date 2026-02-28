import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const webRoot = path.resolve(__dirname, '..')
const publicDir = path.join(webRoot, 'public')
const svgPath = path.join(publicDir, 'favicon.svg')

const pngSizes = [16, 32, 48, 180, 192, 512]
const errors = []

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: webRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || '(no stderr)'
    throw new Error(`${command} ${args.join(' ')} failed: ${stderr}`)
  }
}

async function generateWithSharp(sharpModule, pngToIco) {
  const sharp = sharpModule.default
  for (const size of pngSizes) {
    const outputPath = path.join(publicDir, `favicon-${size}x${size}.png`)
    try {
      await sharp(svgPath)
        .resize(size, size)
        .png()
        .toFile(outputPath)
      console.log(`generated: ${path.basename(outputPath)}`)
    } catch (error) {
      errors.push(`png ${size}x${size}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  try {
    const icoBuffer = await pngToIco.default([
      path.join(publicDir, 'favicon-16x16.png'),
      path.join(publicDir, 'favicon-32x32.png'),
      path.join(publicDir, 'favicon-48x48.png'),
    ])
    await writeFile(path.join(publicDir, 'favicon.ico'), icoBuffer)
    console.log('generated: favicon.ico')
  } catch (error) {
    errors.push(`ico: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function generateWithMagickFallback() {
  console.warn(
    'sharp/png-to-ico unavailable; using ImageMagick fallback. Run `npm install` when network is available.',
  )

  for (const size of pngSizes) {
    const outputPath = path.join(publicDir, `favicon-${size}x${size}.png`)
    try {
      runCommand('magick', [
        'convert',
        '-background',
        'none',
        svgPath,
        '-resize',
        `${size}x${size}`,
        outputPath,
      ])
      console.log(`generated: ${path.basename(outputPath)}`)
    } catch (error) {
      errors.push(`png ${size}x${size}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  try {
    runCommand('magick', [
      'convert',
      path.join(publicDir, 'favicon-16x16.png'),
      path.join(publicDir, 'favicon-32x32.png'),
      path.join(publicDir, 'favicon-48x48.png'),
      path.join(publicDir, 'favicon.ico'),
    ])
    console.log('generated: favicon.ico')
  } catch (error) {
    errors.push(`ico: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function main() {
  await mkdir(publicDir, { recursive: true })

  try {
    const sharpModule = await import('sharp')
    const pngToIco = await import('png-to-ico')
    await generateWithSharp(sharpModule, pngToIco)
  } catch {
    generateWithMagickFallback()
  }

  if (errors.length > 0) {
    console.error('favicon generation failed:')
    for (const message of errors) {
      console.error(`- ${message}`)
    }
    process.exit(1)
  }

  console.log('favicon generation completed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
