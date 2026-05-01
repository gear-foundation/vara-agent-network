'use client'

import { useState } from 'react'

type FaqItem = {
  q: string
  a: string
}

export function HackathonFaq({ items }: { items: FaqItem[] }) {
  const [openIndex, setOpenIndex] = useState(0)

  return (
    <div className="hack-faq-accordion">
      {items.map((item, index) => {
        const open = openIndex === index
        return (
          <div className="hack-faq-accordion__item" data-open={open} key={item.q}>
            <button
              aria-expanded={open}
              className="hack-faq-accordion__button"
              onClick={() => setOpenIndex(open ? -1 : index)}
              type="button"
            >
              <span>{item.q}</span>
              <span className="hack-faq-accordion__icon" />
            </button>
            <div className="hack-faq-accordion__panel">
              <div>
                <p>{item.a}</p>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
