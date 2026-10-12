# Jami manual QA checklist

What a person has to check by hand before a release, because automated tests
cannot judge it: anything needing an Apple Pencil, anything where the failure is
"looks wrong" rather than "throws", and anything only visible in production.

**Already covered automatically, so do not redo by hand:** `npm run test:e2e`
drives signed-in Chromium against the Firebase emulators through notebook
autosave, drawing and reload; the study review loop and offline replay; browse
and navigation; the Learning Engine's evidence and Today's recommendation; Past
Paper Practice; the First night walkthrough; revision plans; Tutor sources; and
the security headers, at desktop, tablet and phone widths (specs in `e2e/`).
`npm run test:rules` covers the Firestore and Storage rules.

Check layouts at three widths: **desktop ~1440px**, **tablet ~820px**,
**phone ~390px**. Keep the browser console open throughout and note any errors
with the page you were on.

One failure to watch for everywhere: **an equation that makes the whole page
scroll sideways.** Long equations must scroll inside their own box.

## 1. Sign-in and loading

1. Sign in with Google, and with email. A signed-out visit to `/dashboard`
   redirects to sign-in.
2. Hard-reload Today, Learn, Practice, a notebook and Progress. Each loads
   without a console error or a Firebase permission error.
3. Install the app (PWA), open it from the home screen while signed in, and
   confirm it reaches Today.
4. On an account with thousands of cards, open Cards, Progress, Topics and
   Learn twice. The second visit draws at once from the device copy and
   redraws when the server's set arrives. Edit a card, then reload: the edit
   is never shown undone. On Learn's second visit, tap Start Daily Review at
   once: the session opens on the server's cards as soon as they land.

## 2. Notebooks — highest data-loss risk

1. Open an existing notebook with ink on several pages. Every page shows its
   ink, including pages last saved months ago.
2. Draw, type in a text box, and leave the page immediately. Come back: the
   work is there.
3. Flip quickly through ten pages while drawing on some. Nothing lands on the
   wrong page and no page comes back blank.
4. Open a notebook made from a PDF. Pages render and ink sits on top; the
   uploaded PDF itself is never modified.
4a. Write on a page last saved before 12 October, leave it and reopen it: the
   old ink and the new are both there, in place. Then open the same page with
   `NEXT_PUBLIC_ENABLE_JAMI_INK=false` (the js-draw fallback): it shows the
   same ink, and its thumbnail in the pages drawer matches.
5. Use the toolbar, which starts in the middle of the top bar, outlined, and
   covers none of the page, in either orientation; the ring round a pressed
   tool is whole, at the ends too: Pen (P), Highlighter (H), Eraser (E),
   Text box (T), Insert (an image or a graph), Undo and Redo, pen and
   highlighter colour and thickness, and pen smoothing. Undo steps back
   whichever of ink, text, an image or a graph changed last: move an image
   and a graph by hand and undo puts each back, and redo moves it again.
   Deleting an image cannot be undone. Drag the toolbar out to the left,
   right or bottom edge, where it floats over the page, and back up into the
   top bar; it stays where it was left after a reload.
6. Turn on Scribble to erase in the tool settings and scribble over a word. Only
   what was scribbled over disappears, whether the scribble zigzags or loops,
   from three or four quick passes. Then draw a quick circle round a word,
   with the pen and with the highlighter: the circle stays, the word is not
   erased, and the highlighter leaves the middle of the circle clear.
   Draw a slightly wobbly or bowed line, flat and at an angle, and keep the pen
   still at its end: within about four tenths of a second it snaps straight. Keep
   the pen down and move it a few pixels: the far end follows at once, with no jump.
6a. With the pen's hold set to Shapes (the default), draw a rough circle, an
   oval, a rectangle, a triangle and an arrow, keeping the pen still at the
   end of each: each snaps to its shape, a near-level one level. Keep the pen
   down and move it: the shape grows, shrinks and turns with it, and a nudge
   does not tilt a level one; sizing it over some writing erases nothing.
   Draw a square and carry on up its first side again, pausing where it
   closes or not: it is still a level square of the size drawn. Undo once:
   the stroke as you drew it comes back; undo again: it goes. A small 'o', a
   'C' and a figure of eight stay as drawn. On an exam working sheet a held
   circle is left as drawn.
6b. Press Ruler. Move it with one finger and turn it with two: the angle reads
   out and settles on 0, 15, 30 and so on; the page does not pan. Draw along
   either edge with the pen and the highlighter: the line runs exactly along
   it however the hand wanders. A stroke started away from it is untouched.
   Press Ruler again to put it away. The exam working sheet has the same ruler.
6c. Press Lasso (L) and draw a loop round some writing, an image, a graph and a
   text box. Drag inside the box: they all move together, keeping up with
   the pen, and land where you let go with no jump or flicker. A tap inside
   the box moves nothing. Pull the corner: they all grow and shrink (the
   text box takes its new width when you let go). Swing the round handle:
   ink, image and graph turn, the text box stays upright. Pinch the page with
   two fingers while the lasso is out: it zooms. Pick a colour and
   press Thicker, then Thinner. Undo steps back one gesture at a time: one
   undo puts the writing, image, graph and text box back together. Press
   Delete: it all goes, and one undo brings back all but the image. Reload:
   the moved and turned image and graph are where you left them.
7. On a phone, a notebook shows "Notebook editing works best on iPad or
   desktop." with "Continue anyway"; typed notes still work. An iPad mini held
   upright gets the full notebook, with no such notice. With a tool's settings
   or the Insert menu open, Escape closes it and the tool stays in hand.

### On an iPad, with a Pencil

8. Write a full page by hand at natural speed. No lag, no dropped strokes, no
   palm marks while your hand rests on the page.
9. Swipe pages with a finger while the Pen is active: fingers turn pages and
   never draw; the Pencil draws and never turns pages.
10. Highlight across a line, then erase part of the highlight. The rest keeps
    its shape, with no bridges or holes.
11. Rotate the device mid-page. The page and the work survive.
12. Pinch in on a page. One finger pans it the way the rest of the iPad
    scrolls, with momentum, even with Low Power Mode on; the Pencil keeps
    writing and never moves the page; a resting palm while writing does not
    move it either, nor change the zoom when it lands to start writing;
    pinching in and out still zooms about your fingers; back at fit, a
    sideways swipe turns the page again.
13. With Low Power Mode on, open a notebook: within a couple of seconds it
    says Low Power Mode is slowing writing down. Turn it off in Settings and
    come back: the note goes.

## 3. Learn and flashcards

1. Daily Review, Focused Review and Simple Study each start, grade, and finish
   with the right counts.
2. Turn the network off, review three cards, turn it back on. The reviews sync
   once each, and the offline banner comes and goes.
3. Diagram cards: add a picture, cover its labels, and study it both as one
   card and as a card per label (see [`image-occlusion.md`](image-occlusion.md)).
4. Import an Anki package with images, and make cards from a video. Nothing the
   AI drafts joins a deck until it is accepted.

## 4. Practice and generated papers

1. `/dashboard/practice` shows recent notebooks under Continue working and
   folders under Study spaces.
2. A folder's tabs are Notebooks, Practice (when Past Paper Practice is on),
   Decks and Sources. Adding an existing deck or source to a folder, and
   removing it, never deletes the deck or source.
3. Generate a paper from `/dashboard/practice/new`. It is typeset in the
   board's house style, its graphs are drawn rather than pictured, and its
   print view (`/dashboard/practice/papers/<id>/print`) prints cleanly.
4. Answer the paper by hand and have it marked. Leave the page while it marks
   and come back: the mark arrives anyway.

## 5. Past Paper Practice

Behind `enablePastPaperPractice`, and behind a board switch on top of that. Skip
this section entirely when both are off — a not-found page is the correct
behaviour, and is itself worth confirming once.

Two AI steps here are durable jobs rather than parts of the request that asks
for them, so most of what follows is about states that outlive a page. None of
it can be judged from a screenshot taken at the right moment.

### Setup and session

1. Open `/dashboard/practice/questions/new?folderId=...` for a folder with an exam course.
2. Confirm the per-difficulty counts read `n ready` or `n+ ready`, not a raw total.
3. On a course with a checked topic list, confirm `Narrow to topics` appears and selecting one changes the counts.
4. On a course without one, confirm the explicit "Topics aren't available for this course yet" line appears — **not** an absent control.
5. Narrow until a shortage is forced. Confirm the shortage card offers Jami-created questions, starting short, or changing the mix.
6. Start a session and confirm the question, its tariff and any figure render.

### Answering

7. Type an answer, change question, come back: confirm the draft survived.
8. Type an answer and reload the page mid-sentence: confirm the last words are not lost.
9. Open the working sheet, draw, and confirm the pen, highlighter, eraser, undo, redo and colours behave as the notebook's do.
10. Confirm the sheet honours your saved pen-feel preference rather than a hardcoded one.
11. Submit and confirm the answer and sheet both freeze.

### Marking, which does not happen in the request

12. Confirm the page says the answer is being marked and that it carries on if you leave.
13. **Leave the page entirely, come back, and confirm the mark arrives anyway.** This cannot be seen any other way.
14. Confirm the mark report leads with the mark, then what earned it, then what to add next time.
15. Force a failure (kill the provider key) and confirm the failure card explains *which* failure, and only offers a retry for one that retrying could fix.
16. Confirm an over-long answer reopens for editing rather than freezing with a dead retry button.

### Checking a mark, which also does not

17. From a marked answer, press `Check this mark`.
18. Reload while it runs: confirm it still says a check is in progress and the button is not offered again.
19. Confirm a completed check shows the before and after marks when they differ, and says the mark stood when they do not.
20. Force a failing check and confirm it says the mark stands, says the check has not been used up, and offers `Try checking again`.
21. Confirm a second check is refused once one has completed.

### Retry, history and export

22. Take the guided second attempt and confirm the first mark stays readable beside it.
23. Finish the session and confirm the summary scores what was marked, not the whole paper.
24. Open `/dashboard/practice/history` and confirm the session reads correctly.
25. Export a marked question to a notebook and confirm the working image is not squashed — it is portrait, and should stay portrait.

### Owner surfaces

26. In `/dashboard/internal/exam-corpus`, ingest a paper as a dry run and confirm it reports what it extracted without storing anything.
27. Work the review queue and confirm question and paired scheme sit side by side.
28. Draw a spot-check sample and confirm it differs between draws.
29. Record a spot-check with nothing rejected and confirm the paper's questions become servable.
30. Record one rejecting everything drawn and confirm nothing becomes servable and the attempt is still recorded.

## 6. Tutor and sources

1. Add a source in `/dashboard/library` (a PDF, a pasted note, a link). Saving
   it creates no drafts, cards or questions on its own.
2. Ask Tutor (`/dashboard/tutor`, or the drawer in a notebook) about something
   in a folder with many sources. The answer draws on the right source by
   content, not by file name.
3. Ask Tutor to make flashcards from the conversation. They arrive as drafts to
   accept or discard.
4. In Personalise Jami (`/dashboard/tutor/personalise`), open the memory map.
   Correct a note, delete one, then turn memory off and confirm Tutor stops
   using it.
5. Make a revision plan from Tutor, and confirm Today then leads with the week
   and the next task.

## 7. Today, the Learning Engine and Revision Sessions

1. Without a revision plan, Today shows one next step, with "Why this?" folded
   away. The step's link opens the right page.
2. A topic with little evidence is never called weak, and untested topics are
   never shown as weak.
3. Start a Revision Session from a folder's Notebooks tab or from
   `/dashboard/revision/start?folder=...`. It opens full screen with no chat UI,
   teaches, asks a guided question, gives one retry when wrong, and then asks
   questions on your own.
4. Leave mid-session and come back within four hours: it resumes at the same
   step.
5. At the end, choose **Do later** on a next step and find it on the Tutor
   shelf.

See [`learning-engine-verification.md`](learning-engine-verification.md) for the
owner's production checks against real infrastructure.

## 8. Notifications

1. Turn notifications on in Account and allow them in the browser.
2. The daily nudge arrives after 4pm local time, and the evening reminder after
   7pm while Daily Review still has cards waiting. Nothing arrives after 10pm.
3. Turn the evening reminder off and confirm it stops the next day.
4. Change the device's time zone, open the dashboard, and confirm the next nudge
   follows the new zone. See [`notifications.md`](notifications.md).

## 9. Themes and long content

1. Switch themes and app backgrounds in `/dashboard/profile/personalise`. Text stays readable on
   every surface, including dialogs and the notebook toolbar.
2. On a phone, open a card, a Tutor reply and a mark report each containing a
   long equation. Only the equation scrolls.

## 10. Boundaries

These must never appear:

- the retired per-student question bank, its standalone Add question form, or
  mandatory per-question confidence blocks;
- any suggestion that Jami watches the screen, reads handwriting on its own, or
  processes uploads in the background;
- licensed exam questions whose permission record is missing, revoked or for a
  superseded specification.

## Reporting back

For each failure, give the section and step, the width or device, what you
expected, what happened, and any console error. A screenshot or recording helps
for anything visual.
