import { VideoEditorView } from './VideoEditorView'
import './screen-capture.css'

const VIDEO_EDIT_PREVIEW_SRC = `${import.meta.env.BASE_URL}videos/preview.mp4`

export function App() {
  return (
    <div className="screen-capture-root" role="application" aria-label="Screen Capture">
      <VideoEditorView
        videoSrc={VIDEO_EDIT_PREVIEW_SRC}
        onDone={() => {
          /* Prototype entry point — wire up navigation when capture flow is added. */
        }}
        onSave={() => {
          /* Prototype entry point — wire up save when capture flow is added. */
        }}
        onDelete={() => {
          /* Prototype entry point — wire up navigation when capture flow is added. */
        }}
      />
    </div>
  )
}
