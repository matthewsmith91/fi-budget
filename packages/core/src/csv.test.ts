import { describe, expect, it } from 'vitest'
import { parseCsv } from './csv.ts'

describe('parseCsv', () => {
  it('reads plain rows, with LF, CRLF or CR line ends', () => {
    expect(parseCsv('a,b\n1,2\r\n3,4\r5,6')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
      ['5', '6'],
    ])
  })

  it('reads quoted fields with commas, doubled quotes and line breaks', () => {
    expect(parseCsv('"Smith, J","say ""hi""","two\nlines"\n')).toEqual([
      ['Smith, J', 'say "hi"', 'two\nlines'],
    ])
  })

  it('keeps empty fields, drops blank lines and the byte-order mark', () => {
    expect(parseCsv('﻿a,,c\n\n,,\nx,y,z\n')).toEqual([
      ['a', '', 'c'],
      ['', '', ''],
      ['x', 'y', 'z'],
    ])
  })

  it('refuses text cut off inside a quote', () => {
    expect(() => parseCsv('a,"b')).toThrow(/cut off/)
  })
})
