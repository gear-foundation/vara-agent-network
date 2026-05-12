#!/usr/bin/env node

const expr = process.argv.slice(2).join(' ')

if (!expr) {
  console.error('usage: json-get.mjs <js-expression-using-data>')
  process.exit(2)
}

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  raw += chunk
})

process.stdin.on('end', () => {
  try {
    const data = JSON.parse(raw)
    const fn = new Function('data', `return (${expr})`)
    const value = fn(data)

    if (value === undefined || value === null) return
    if (typeof value === 'object') {
      console.log(JSON.stringify(value))
      return
    }
    console.log(String(value))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
})
