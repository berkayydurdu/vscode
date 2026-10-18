/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Comment, Item, ItemChange, Review, Verdict, Worklog } from './api';
import { select } from './card';
import { autosize, confirmDialog, kindIcon, labelChip, preservingFocus, priorityIcon, reportError, showMenu, statusIcon, toast } from './components';
import { t } from './l10n';
import { kindLabel, priorityLabel, statusLabel, type Model } from './model';
import { pickDate, pickEstimate, pickLabels, pickPeople, pickPriority, pickStatus } from './pickers';
import { avatar, formatMinutes, h, icon, newId, renderMarkdown, shortDate, timeAgo } from './util';
import { logTimeDialog } from './views/timesheet';

interface Extras {
	seq: number;
	comments: Comment[];
	worklogs: Worklog[];
	reviews: Review[];
}

/**
 * The item page that slides in from the right, like a Notion peek: every
 * property, the description, to-dos, time entries, reviews and comments.
 * RFCs open wide, as a document.
 */
export class DetailPanel {

	readonly el = h('aside', { class: 'detail', 'aria-label': t('Item details') });
	private itemId: string | null = null;
	private extras: Extras | undefined;
	private loadingSeq = -1;
	private expanded = false;

	// Drafts survive re-renders, which happen whenever a teammate changes something.
	private editingBody: string | null = null;
	private titleDraft: string | null = null;
	private commentDraft = '';
	private todoDraft = '';
	private reviewDraft: { verdict: Verdict; body: string } | null = null;

	constructor(private readonly model: Model) {
		model.onItem(item => {
			if (item.id === this.itemId && item.deleted) {
				select(model, null);
			}
		});
	}

	get isOpen(): boolean {
		return !!this.itemId;
	}

	/** Called on every model change; redraws when the item is open. */
	update(): void {
		const id = this.model.selected;
		if (id !== this.itemId) {
			this.itemId = id;
			this.extras = undefined;
			this.editingBody = this.titleDraft = this.reviewDraft = null;
			this.commentDraft = this.todoDraft = '';
			this.el.scrollTop = 0;
		}
		const item = id ? this.model.items.get(id) : undefined;
		document.body.classList.toggle('detail-open', !!item);
		if (!item) {
			this.el.replaceChildren();
			return;
		}
		if (this.extras?.seq !== item.seq && this.loadingSeq !== item.seq) {
			this.loadExtras(item);
		}
		const scroller = this.el.querySelector('.detail-scroll');
		const scrollTop = scroller?.scrollTop ?? 0;
		preservingFocus(() => this.el.replaceChildren(...this.render(item)));
		const next = this.el.querySelector('.detail-scroll');
		if (next) {
			next.scrollTop = scrollTop;
		}
	}

	close(): boolean {
		if (!this.itemId) {
			return false;
		}
		select(this.model, null);
		return true;
	}

	private loadExtras(item: Item): void {
		this.loadingSeq = item.seq;
		this.model.api.item(item.id).then(({ item: latest, comments, worklogs, reviews }) => {
			if (this.itemId !== item.id) {
				return;
			}
			this.extras = { seq: latest.seq, comments, worklogs, reviews };
			this.model.put(latest);
			this.update();
		}, err => {
			this.loadingSeq = -1;
			reportError(err);
		});
	}

	private save(item: Item, change: ItemChange, checkVersion = false): Promise<Item | undefined> {
		return this.model.update(item, change, { checkVersion }).catch(err => {
			reportError(err);
			return undefined;
		});
	}

	private render(item: Item): Node[] {
		const isRfc = item.kind === 'rfc';
		this.el.classList.toggle('doc', isRfc || this.expanded);
		return [
			this.bar(item),
			h('div', { class: 'detail-scroll' },
				h('div', { class: 'detail-body' },
					this.title(item),
					this.properties(item),
					isRfc ? this.reviewPanel(item) : null,
					this.description(item),
					this.checklist(item),
					isRfc ? null : this.time(item),
					this.comments(item),
				),
			),
		];
	}

	private bar(item: Item): HTMLElement {
		const more = (anchor: HTMLElement) => showMenu(anchor, [
			{ id: 'copy', label: t('Copy ID'), icon: icon('doc', 14), hint: this.model.key(item) },
			...(this.model.canEdit && item.kind !== 'rfc' ? [{ id: 'convert', label: item.kind === 'bug' ? t('Turn into Task') : t('Turn into Bug'), icon: kindIcon(item.kind === 'bug' ? 'task' : 'bug') }] : []),
			...(this.model.canEdit ? [{ id: 'delete', label: t('Delete'), icon: icon('trash', 14), danger: true }] : []),
		], async id => {
			if (id === 'copy') {
				await navigator.clipboard.writeText(`${this.model.key(item)} ${item.title}`).catch(() => undefined);
				toast(t('Copied {0}', this.model.key(item)));
			} else if (id === 'convert') {
				this.save(item, { kind: item.kind === 'bug' ? 'task' : 'bug' });
			} else if (id === 'delete' && await confirmDialog(t('Delete {0}?', this.model.key(item)), t('"{0}" and its comments and time entries will be deleted for everyone.', item.title), t('Delete'))) {
				this.model.remove(item).catch(reportError);
			}
		}, { search: false });
		return h('header', { class: 'detail-bar' },
			h('span', { class: 'detail-key' }, kindIcon(item.kind), kindLabel(item.kind), h('span', { class: 'muted' }, '/'), this.model.key(item)),
			h('span', { class: 'spacer' }),
			item.kind !== 'rfc' && this.model.canEdit ? h('button', { class: 'button ghost small', onclick: () => logTimeDialog(this.model, { itemId: item.id }) }, icon('clock', 14), t('Log Time')) : null,
			item.kind !== 'rfc' ? h('button', { class: 'icon-button', title: this.expanded ? t('Show as Side Panel') : t('Expand'), onclick: () => { this.expanded = !this.expanded; this.update(); } }, icon(this.expanded ? 'chevronRight' : 'chevronLeft', 14)) : null,
			h('button', { class: 'icon-button', title: t('More Actions'), onclick: (e: Event) => more(e.currentTarget as HTMLElement) }, icon('more', 14)),
			h('button', { class: 'icon-button', title: t('Close (Esc)'), onclick: () => this.close() }, icon('close', 14)),
		);
	}

	private title(item: Item): HTMLElement {
		const area = autosize(h('textarea', {
			class: 'detail-title',
			rows: 1,
			value: this.titleDraft ?? item.title,
			readOnly: !this.model.canEdit,
			'data-key': 'detail:title',
			placeholder: t('Untitled'),
			spellcheck: true,
		}));
		const commit = () => {
			const title = area.value.replace(/\s+/g, ' ').trim();
			this.titleDraft = null;
			if (title && title !== item.title) {
				this.save(item, { title });
			} else {
				area.value = item.title;
			}
		};
		area.addEventListener('input', () => this.titleDraft = area.value);
		area.addEventListener('keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				area.blur();
			}
		});
		area.addEventListener('blur', commit);
		return area;
	}

	private properties(item: Item): HTMLElement {
		const canEdit = this.model.canEdit;
		const prop = (iconName: string, label: string, value: Node | Node[], onClick?: (anchor: HTMLElement) => void) =>
			h('div', { class: 'property' },
				h('span', { class: 'property-label' }, icon(iconName, 14), label),
				onClick && canEdit
					? h('button', { class: 'property-button', onclick: (e: Event) => onClick(e.currentTarget as HTMLElement) }, value)
					: h('span', { class: 'property-value' }, value),
			);
		const empty = (text: string) => h('span', { class: 'muted' }, text);
		const people = (ids: string[]) => ids.length
			? this.model.people(ids).map(p => h('span', { class: 'person' }, avatar(p), p.name))
			: [empty(t('Empty'))];
		const author = this.model.member(item.createdBy);
		const isRfc = item.kind === 'rfc';
		const rows: (HTMLElement | null)[] = [
			prop('sync', t('Status'), [statusIcon(item.kind, item.status), h('span', null, statusLabel(item.kind, item.status))], anchor => pickStatus(anchor, item.kind, item.status, status => this.save(item, { status }))),
			isRfc ? prop('user', t('Author'), author ? [avatar(author), h('span', null, author.name)] : [empty(t('Former member'))]) : null,
			isRfc
				? prop('people', t('Reviewers'), people(item.reviewers), anchor => pickPeople(anchor, this.model, item.reviewers, reviewers => this.save(item, { reviewers }), t('Ask for review...')))
				: prop('user', t('Assignees'), people(item.assignees), anchor => pickPeople(anchor, this.model, item.assignees, assignees => this.save(item, { assignees }))),
			prop('board', t('Priority'), [priorityIcon(item.priority), h('span', null, priorityLabel(item.priority))], anchor => pickPriority(anchor, item.priority, priority => this.save(item, { priority }))),
			isRfc ? null : prop('calendar', t('Due date'), item.dueDate ? [h('span', null, new Date(item.dueDate + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }))] : [empty(t('Empty'))], anchor => pickDate(anchor, item.dueDate, dueDate => this.save(item, { dueDate }))),
			isRfc ? null : prop('clock', t('Estimate'), item.estimateMinutes ? [h('span', null, formatMinutes(item.estimateMinutes))] : [empty(t('Empty'))], anchor => pickEstimate(anchor, item.estimateMinutes, estimateMinutes => this.save(item, { estimateMinutes }))),
			isRfc ? null : prop('clock', t('Time logged'), [
				h('span', null, formatMinutes(item.loggedMinutes)),
				item.estimateMinutes ? h('span', { class: 'meter inline' }, h('span', { class: { 'meter-fill': true, over: item.loggedMinutes > item.estimateMinutes }, style: `width: ${Math.min(100, item.loggedMinutes / item.estimateMinutes * 100)}%` })) : null,
				item.estimateMinutes ? h('span', { class: 'muted small' }, item.loggedMinutes > item.estimateMinutes ? t('{0} over', formatMinutes(item.loggedMinutes - item.estimateMinutes)) : t('{0} left', formatMinutes(item.estimateMinutes - item.loggedMinutes))) : null,
			].filter((n): n is HTMLElement => !!n)),
			prop('tag', t('Labels'), item.labels.length ? item.labels.map(label => labelChip(label)) : [empty(t('Empty'))], anchor => pickLabels(anchor, this.model, item.labels, labels => this.save(item, { labels }))),
			isRfc ? null : prop('user', t('Created by'), [avatar(author), h('span', null, author?.name ?? t('Former member')), h('span', { class: 'muted small' }, shortDate(item.createdAt))]),
		];
		return h('div', { class: 'properties' }, rows);
	}

	private description(item: Item): HTMLElement {
		const isRfc = item.kind === 'rfc';
		const heading = h('div', { class: 'section-heading' },
			h('h3', null, isRfc ? t('Proposal') : t('Description')),
			h('span', { class: 'spacer' }),
			this.model.canEdit && this.editingBody === null && item.body ? h('button', { class: 'button ghost small', onclick: () => { this.editingBody = item.body; this.update(); } }, t('Edit')) : null,
		);
		if (this.editingBody !== null) {
			const area = autosize(h('textarea', { class: 'markdown-editor', value: this.editingBody, 'data-key': 'detail:body', placeholder: t('Write in Markdown...') }));
			area.addEventListener('input', () => this.editingBody = area.value);
			const done = async (keep: boolean) => {
				if (keep && this.editingBody !== item.body) {
					const saved = await this.save(item, { body: this.editingBody ?? '' }, true);
					if (!saved) {
						return;
					}
				}
				this.editingBody = null;
				this.update();
			};
			area.addEventListener('keydown', e => {
				if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
					done(true);
				} else if (e.key === 'Escape') {
					e.stopPropagation();
					done(false);
				}
			});
			requestAnimationFrame(() => document.activeElement === document.body && area.focus());
			return h('section', { class: 'detail-section' }, heading, area,
				h('div', { class: 'editor-actions' },
					h('span', { class: 'muted small' }, t('Markdown: **bold**, - lists, - [ ] to-dos, ## headings, [[note links]]. Ctrl+Enter saves.')),
					h('span', { class: 'spacer' }),
					h('button', { class: 'button ghost small', onclick: () => done(false) }, t('Cancel')),
					h('button', { class: 'button primary small', onclick: () => done(true) }, t('Save')),
				));
		}
		const content = item.body
			? this.editable(renderMarkdown(item.body), item)
			: this.model.canEdit
				? h('button', { class: 'placeholder', onclick: () => { this.editingBody = isRfc ? RFC_TEMPLATE : ''; this.update(); } }, isRfc ? t('Start from the RFC template...') : t('Add a description...'))
				: h('div', { class: 'muted' }, t('No description.'));
		return h('section', { class: 'detail-section' }, heading, content);
	}

	/** Double-clicking the rendered description starts editing it. */
	private editable(content: HTMLElement, item: Item): HTMLElement {
		content.addEventListener('dblclick', () => {
			if (this.model.canEdit) {
				this.editingBody = item.body;
				this.update();
			}
		});
		return content;
	}

	private checklist(item: Item): HTMLElement | null {
		const canEdit = this.model.canEdit;
		if (!item.checklist.length && !canEdit) {
			return null;
		}
		const done = item.checklist.filter(c => c.done).length;
		const set = (checklist: Item['checklist']) => this.save(item, { checklist }, true);
		const add = h('input', { class: 'todo-add', placeholder: t('Add a to-do, then Enter'), value: this.todoDraft, 'data-key': 'detail:todo' });
		add.addEventListener('input', () => this.todoDraft = add.value);
		add.addEventListener('keydown', e => {
			if (e.key === 'Enter' && add.value.trim()) {
				const text = add.value.trim();
				this.todoDraft = '';
				set([...item.checklist, { id: newId(), text, done: false }]);
			}
		});
		return h('section', { class: 'detail-section' },
			h('div', { class: 'section-heading' },
				h('h3', null, t('To-dos')),
				item.checklist.length ? h('span', { class: 'muted small' }, t('{0} of {1}', done, item.checklist.length)) : null,
				item.checklist.length ? h('span', { class: 'meter inline' }, h('span', { class: { 'meter-fill': true, full: done === item.checklist.length }, style: `width: ${done / item.checklist.length * 100}%` })) : null,
			),
			h('div', { class: 'checklist' }, item.checklist.map(entry => h('div', { class: { 'todo': true, done: entry.done } },
				h('button', {
					class: { checkbox: true, checked: entry.done },
					disabled: !canEdit,
					title: entry.done ? t('Mark Not Done') : t('Mark Done'),
					onclick: () => set(item.checklist.map(c => c.id === entry.id ? { ...c, done: !c.done } : c)),
				}, entry.done ? icon('check', 12) : null),
				h('span', { class: 'todo-text' }, entry.text),
				canEdit ? h('button', { class: 'icon-button hover-only', title: t('Remove'), onclick: () => set(item.checklist.filter(c => c.id !== entry.id)) }, icon('close', 12)) : null,
			))),
			canEdit ? add : null,
		);
	}

	private time(item: Item): HTMLElement {
		const logs = [...this.extras?.worklogs ?? []].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
		const byPerson = new Map<string, number>();
		logs.forEach(log => byPerson.set(log.userId, (byPerson.get(log.userId) ?? 0) + log.minutes));
		return h('section', { class: 'detail-section' },
			h('div', { class: 'section-heading' },
				h('h3', null, t('Time')),
				h('span', { class: 'muted small' }, formatMinutes(item.loggedMinutes)),
				h('span', { class: 'spacer' }),
				this.model.canEdit ? h('button', { class: 'button ghost small', onclick: () => logTimeDialog(this.model, { itemId: item.id }) }, icon('plus', 12), t('Log Time')) : null,
			),
			byPerson.size > 1 ? h('div', { class: 'time-split' }, [...byPerson].map(([userId, minutes]) => h('span', { class: 'person' }, avatar(this.model.member(userId)), formatMinutes(minutes)))) : null,
			logs.length
				? h('div', { class: 'worklogs' }, logs.map(log => {
					const person = this.model.member(log.userId);
					const mine = log.userId === this.model.me.id ? this.model.canEdit : this.model.isAdmin;
					return h('div', { class: 'worklog' },
						avatar(person),
						h('span', { class: 'worklog-who' }, person?.name ?? t('Former member')),
						h('span', { class: 'muted small' }, shortDate(log.date)),
						h('span', { class: 'worklog-note' }, log.note),
						h('span', { class: 'spacer' }),
						h('strong', null, formatMinutes(log.minutes)),
						mine ? h('button', {
							class: 'icon-button hover-only', title: t('Delete Entry'), onclick: async () => {
								await this.model.api.deleteWorklog(log.id).catch(reportError);
								this.model.reload(item.id).catch(reportError);
							},
						}, icon('trash', 12)) : null,
					);
				}))
				: h('div', { class: 'muted small' }, this.extras ? t('No time logged yet.') : t('Loading...')),
		);
	}

	private reviewPanel(item: Item): HTMLElement {
		const reviews = this.extras?.reviews ?? [];
		const people = [...new Set([...item.reviewers, ...reviews.map(r => r.userId)])];
		const approvals = reviews.filter(r => r.verdict === 'approve').length;
		const verdictBadge = (review?: { verdict: Verdict }) => {
			if (!review) {
				return h('span', { class: 'verdict pending' }, t('Pending'));
			}
			return review.verdict === 'approve'
				? h('span', { class: 'verdict approve' }, icon('approve', 12), t('Approved'))
				: review.verdict === 'request_changes'
					? h('span', { class: 'verdict changes' }, icon('changes', 12), t('Changes requested'))
					: h('span', { class: 'verdict comment' }, icon('comment', 12), t('Commented'));
		};
		const actions: (HTMLElement | null)[] = [];
		if (this.model.canEdit) {
			if (item.status === 'draft') {
				actions.push(h('button', { class: 'button primary', onclick: () => this.save(item, { status: 'in_review' }) }, t('Request Review')));
			} else if (item.status === 'in_review') {
				actions.push(
					h('button', { class: 'button', 'data-review': 'approve' }, icon('approve', 14), t('Approve')),
					h('button', { class: 'button', 'data-review': 'request_changes' }, icon('changes', 14), t('Request Changes')),
					h('button', { class: 'button ghost', 'data-review': 'comment' }, icon('comment', 14), t('Comment')),
					h('span', { class: 'spacer' }),
					h('button', { class: 'button ghost', onclick: () => this.save(item, { status: 'accepted' }) }, t('Accept RFC')),
					h('button', { class: 'button ghost', onclick: () => this.save(item, { status: 'rejected' }) }, t('Reject')),
				);
			}
		}
		actions.forEach(button => {
			const verdict = button?.dataset.review as Verdict | undefined;
			if (verdict) {
				button!.onclick = () => {
					this.reviewDraft = { verdict, body: reviews.find(r => r.userId === this.model.me.id)?.body ?? '' };
					this.update();
				};
			}
		});

		let form: HTMLElement | null = null;
		if (this.reviewDraft) {
			const draft = this.reviewDraft;
			const area = autosize(h('textarea', { class: 'text-input', rows: 3, value: draft.body, 'data-key': 'detail:review', placeholder: draft.verdict === 'approve' ? t('Anything to add? (optional)') : t('What should change?') }));
			area.addEventListener('input', () => draft.body = area.value);
			const submit = async () => {
				try {
					const latest = await this.model.api.review(item.id, draft.verdict, draft.body.trim());
					this.reviewDraft = null;
					if (this.extras) {
						this.extras.reviews = latest;
					}
					await this.model.reload(item.id);
				} catch (err) {
					reportError(err);
				}
			};
			form = h('div', { class: 'review-form' },
				h('div', { class: 'review-form-title' }, verdictBadge(draft)),
				area,
				h('div', { class: 'editor-actions' },
					h('span', { class: 'spacer' }),
					h('button', { class: 'button ghost small', onclick: () => { this.reviewDraft = null; this.update(); } }, t('Cancel')),
					h('button', { class: 'button primary small', onclick: submit }, t('Submit Review')),
				));
			requestAnimationFrame(() => document.activeElement === document.body && area.focus());
		}

		return h('section', { class: 'review-panel' },
			h('div', { class: 'section-heading' },
				h('h3', null, t('Reviews')),
				people.length ? h('span', { class: 'muted small' }, t('{0} of {1} approved', approvals, people.length)) : null,
			),
			people.length
				? h('div', { class: 'reviews' }, people.map(userId => {
					const review = reviews.find(r => r.userId === userId);
					const person = this.model.member(userId);
					return h('div', { class: 'review' },
						avatar(person),
						h('div', { class: 'review-main' },
							h('div', { class: 'review-head' }, h('strong', null, person?.name ?? t('Former member')), verdictBadge(review), review ? h('span', { class: 'muted small' }, timeAgo(review.createdAt)) : null),
							review?.body ? renderMarkdown(review.body, 'markdown small') : null,
						),
					);
				}))
				: h('div', { class: 'muted small' }, t('No reviewers yet. Add them under Reviewers above.')),
			form ?? (actions.length ? h('div', { class: 'review-actions' }, actions) : null),
		);
	}

	private comments(item: Item): HTMLElement {
		const comments = this.extras?.comments ?? [];
		const area = autosize(h('textarea', { class: 'comment-input', rows: 1, value: this.commentDraft, placeholder: t('Leave a comment...'), 'data-key': 'detail:comment' }));
		const send = async () => {
			const body = area.value.trim();
			if (!body) {
				return;
			}
			try {
				const comment = await this.model.api.addComment(item.id, body);
				this.commentDraft = '';
				this.extras?.comments.push(comment);
				await this.model.reload(item.id);
			} catch (err) {
				reportError(err);
			}
		};
		area.addEventListener('input', () => this.commentDraft = area.value);
		area.addEventListener('keydown', e => {
			if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
				send();
			}
		});
		return h('section', { class: 'detail-section' },
			h('div', { class: 'section-heading' }, h('h3', null, t('Activity'))),
			h('div', { class: 'comments' },
				h('div', { class: 'event muted small' }, avatar(this.model.member(item.createdBy)), t('{0} created this {1}', this.model.member(item.createdBy)?.name ?? t('Someone'), timeAgo(item.createdAt))),
				comments.map(comment => {
					const person = this.model.member(comment.userId);
					const canDelete = comment.userId === this.model.me.id || this.model.isAdmin;
					return h('div', { class: 'comment' },
						avatar(person, 'md'),
						h('div', { class: 'comment-main' },
							h('div', { class: 'comment-head' },
								h('strong', null, person?.name ?? t('Former member')),
								h('span', { class: 'muted small' }, timeAgo(comment.createdAt)),
								h('span', { class: 'spacer' }),
								canDelete ? h('button', {
									class: 'icon-button hover-only', title: t('Delete Comment'), onclick: async () => {
										await this.model.api.deleteComment(item.id, comment.id).catch(reportError);
										this.extras!.comments = this.extras!.comments.filter(c => c.id !== comment.id);
										this.model.reload(item.id).catch(reportError);
									},
								}, icon('trash', 12)) : null,
							),
							renderMarkdown(comment.body),
						),
					);
				}),
			),
			h('div', { class: 'comment-composer' },
				avatar(this.model.member(this.model.me.id), 'md'),
				area,
				h('button', { class: 'button primary small', onclick: send, title: t('Ctrl+Enter') }, t('Comment')),
			),
		);
	}
}

export const RFC_TEMPLATE = `## Summary

One paragraph explaining the proposal.

## Motivation

Why are we doing this? What problem does it solve?

## Detailed design

How it works, in enough detail that someone could build it.

## Drawbacks

Why should we *not* do this?

## Alternatives

What else was considered, and why is this the best option?

## Unresolved questions

- [ ] What still needs to be decided?
`;
