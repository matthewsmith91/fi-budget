/**
 * Parses CSV text (RFC 4180): quoted fields may hold commas, quotes (doubled) and line
 * breaks. A leading byte-order mark is dropped and blank lines are skipped.
 */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let touched = false

  const endField = () => {
    row.push(field)
    field = ''
    touched = true
  }
  const endRow = () => {
    endField()
    if (row.length > 1 || row[0] !== '') rows.push(row)
    row = []
    touched = false
  }

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
    } else if (c === '"' && field === '') {
      quoted = true
      touched = true
    } else if (c === ',') endField()
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      endRow()
    } else {
      field += c
      touched = true
    }
  }
  if (quoted) throw new Error('The file ends inside a quoted field; it may be cut off')
  if (touched || field !== '') endRow()
  return rows
}
