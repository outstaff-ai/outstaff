# Reconcile

Use this when the office gives you a `reconcile` item: its periodic board sweep found tickets whose status or assignee no longer matches what it knows. The work prompt lists each ticket with its status, who holds it and the facts the office found, such as a ticket in review whose pull requests all merged, a blocked ticket whose blockers all closed, an active ticket nobody works on, or a parent whose sub-tickets all closed. The office decided this from its own records, with no judgement: check each fact against the ticket before you act.

1. For each ticket listed, read it (`ost ticket show <ticket>`): its status, its assignee, its pull requests, its blockers and sub-tickets, and the latest comments.
2. If it is out of step, put it right as yourself: move it (`ost ticket move <ticket> <status>`) and give it to whoever acts next (`ost ticket assign <ticket> <person>`), and say why on the ticket in one line, naming the fact. A ticket whose work is done goes to done; one that waits on an agent goes back to that agent; one that needs a human's decision goes to the requester with what is needed.
3. If it is actually fine (a human is still deciding, or the work goes on elsewhere), leave it alone: no move, no comment.
4. Start no new work: no ticket, no pull request (both are refused in this round). Work that is missing is a proposal for a human, on the ticket.
5. Hand back as in `process/hand-back.md`: `done` when you changed something, with one journal line per ticket you changed; `silent` when every ticket was fine.
