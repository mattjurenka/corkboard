import { Suspense } from "react"

import { Files } from "@/components/files"
import { Frame } from "@/components/frame"

export default function Page() {
  return (
    <Frame>
      <Suspense>
        <Files />
      </Suspense>
    </Frame>
  )
}
