import express from "express"
import cors from "cors"

const app = express()
app.use(cors({ origin: "http://localhost:5173" }))
app.use(express.json())

app.get("/", (req, res) => res.json({ message: "Booky API running" }))

app.listen(3000, () => console.log("Server on http://localhost:3000"))