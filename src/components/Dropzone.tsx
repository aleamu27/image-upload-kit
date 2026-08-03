'use client'

import { useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from 'react'

export interface DropzoneProps {
  onFileSelected: (file: File) => void
  accept?: string
  disabled?: boolean
  /** Render prop — you own all markup/styling; this only wires up the drag/drop/click plumbing. */
  children: (state: { isDragging: boolean; openFileDialog: () => void }) => ReactNode
}

/**
 * Wires up drag-and-drop plus click-to-browse with no visual opinion.
 * Tracks a drag-enter/leave counter rather than toggling on every
 * dragenter/dragleave pair directly — the naive version flickers
 * isDragging on and off as the pointer crosses any nested element inside
 * the drop target, which is what the source project's hand-rolled version did.
 */
export function Dropzone({ onFileSelected, accept = 'image/*', disabled, children }: DropzoneProps) {
  const [isDragging, setIsDragging] = useState(false)
  const dragCounter = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const openFileDialog = () => {
    if (!disabled) inputRef.current?.click()
  }

  const handleDragEnter = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragCounter.current += 1
    setIsDragging(true)
  }

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragCounter.current = Math.max(0, dragCounter.current - 1)
    if (dragCounter.current === 0) setIsDragging(false)
  }

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragCounter.current = 0
    setIsDragging(false)
    if (disabled) return
    const file = e.dataTransfer.files?.[0]
    if (file) onFileSelected(file)
  }

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) onFileSelected(file)
    e.target.value = '' // lets the same file be re-selected consecutively
  }

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children({ isDragging, openFileDialog })}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={handleInputChange}
        disabled={disabled}
        style={{ display: 'none' }}
        aria-label="Choose an image to upload"
      />
    </div>
  )
}
