import { describe, expect, it } from 'vitest'
import { styleProblems } from '../src/style.ts'

describe('machine-writing tells in a pitch', () => {
  it('flags the comment the scout posted on Webnation', () => {
    const problems = styleProblems('Such an inspiring story about your guest leaving behind the American Dream to build a new life in Ghana. I turned the part where they reflect on making that life-changing transition into a vertical clip for Shorts. Let me know if you would like me to share it with you!')
    expect(problems.join(' | ')).toMatch(/such an inspiring/iu)
    expect(problems.join(' | ')).toMatch(/life-changing/iu)
    expect(problems.join(' | ')).toMatch(/let me know if you would like/iu)
  })

  it('passes a plain, specific note the way a person writes one', () => {
    expect(styleProblems('The part around 18:40 where she talks about packing up the US life for Accra got me. I cut it into a 40s vertical clip for Shorts, want it?')).toEqual([])
    expect(styleProblems('honestly the landlord story at 12:40 is the bit people will argue about. made a vertical clip of it, happy to send it over if you want it')).toEqual([])
    expect(styleProblems('Loved the episode! I clipped the lawyer bit.')).toEqual([])
  })

  it('flags long dashes and more than one exclamation mark', () => {
    expect(styleProblems('Great episode — I clipped a bit')).toHaveLength(1)
    expect(styleProblems('Great episode! Clipped a bit!')).toEqual(['2 exclamation marks: one at most'])
  })
})
