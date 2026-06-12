import { parseChapterHeadingFromOcrTexts } from "../imageOcrService.js"

const samples = [
  {
    label: "city of bells",
    input: { bannerText: "Ee —- 7 i [ENA a 'oa: CITY OF BELLS - aR : AR" },
  },
  {
    label: "ten heartbeats",
    input: { bannerText: "B J > 13] — OER I TEN HEARTBEATS BWI AEP ARS!" },
  },
  {
    label: "payday",
    input: { bannerText: "Ph ry fo 5% 2h yer To h Se ne ; CL Lo PAYDAY - BEEN" },
  },
  {
    label: "why men lie",
    input: { numberText: "21", titleText: "WHY MEN LIE" },
  },
]

for (const sample of samples) {
  console.log(sample.label, parseChapterHeadingFromOcrTexts(sample.input))
}
