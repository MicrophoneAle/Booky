import { Routes, Route } from "react-router-dom"
import Home from "./pages/Home"
import Reader from "./pages/Reader"
import { paginateDocument, getChapterPages } from "./utils/paginator"

const mockDocument = {
  title: "Test Book",
  chapters: [
    { id: "chapter-one", title: "Chapter One", pageIndex: 0, blockIndex: 0 }
  ],
  content: [
    {
      pageIndex: 0,
      blocks: [
        { text: "Chapter One", isHeading: true, fontSize: 24, chapterId: "chapter-one" },
        { text: "It was a dark and stormy night. The wind howled through the trees as the old man sat by the fire, reading a tattered book he had found in the attic many years ago.", isHeading: false, fontSize: 12, chapterId: "chapter-one" },
        { text: "Chapter Two", isHeading: true, fontSize: 24, chapterId: "chapter-two" },
        { text: "The morning came slowly, as it always did in winter. Grey light crept through the curtains and fell across the wooden floor in long pale stripes.", isHeading: false, fontSize: 12, chapterId: "chapter-two" }
      ]
    }
  ]
}

const pages = paginateDocument(mockDocument)
console.log("Pages:", pages)
console.log("Chapter map:", getChapterPages(pages))

function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/read/:id" element={<Reader />} />
    </Routes>
  )
}

export default App