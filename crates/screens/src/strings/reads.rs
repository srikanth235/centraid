//! The words of the kit's "What <app> may read" page (owner, 2026-11-19), opened from the More sheet
//! of Notes, Docs, Money and People as Calendar, Reminders and Health open theirs. Each app lists
//! what its manifest lets it read of the vault (the kinds, not the plumbing), and what it writes.

catalog! {
    plain docs_reads = ("documents, folders, photos", "documents, folders, photos");
    plain docs_writes = ("documents and folders you make", "documents and folders you make");
    plain label_reads = ("Reads", "Reads");
    plain label_writes = ("Writes", "Writes");
    plain money_reads = (
        "transactions, accounts, categories, budgets, rules, documents, photos",
        "transactions, accounts, categories, budgets, rules, documents, photos"
    );
    plain money_writes = (
        "statements you import, and the names, categories, budgets and rules you set",
        "statements you import, and the names, categories, budgets and rules you set"
    );
    plain notes_reads = (
        "notes, notebooks, people, events, tasks, documents, photos",
        "notes, notebooks, people, events, tasks, documents, photos"
    );
    plain notes_writes = ("notes and notebooks you make", "notes and notebooks you make");
    plain people_reads = (
        "people, lists, notes, events, reminders, transactions, documents, photos",
        "people, lists, notes, events, reminders, transactions, documents, photos"
    );
    plain people_writes = (
        "people, lists, notes and tasks you make",
        "people, lists, notes and tasks you make"
    );
    plain title = ("What {app} may read", "What {app} may read");
}
