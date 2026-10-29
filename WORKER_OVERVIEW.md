# Πώς λειτουργεί ο VP Execution Worker

Ο worker είναι μια ανεξάρτητη Node.js υπηρεσία που καταναλώνει Visual Programming events από ένα AWS SQS queue. Δεν συνδέεται 
απευθείας σε βάση δεδομένων· όλες οι ενέργειες εκτελούνται μέσω προστατευμένων endpoints του backend.

## Βασική ροή

1. Κατά την εκκίνηση φορτώνει τις ρυθμίσεις AWS, SQS, backend και JWT από environment variables.
2. Κάνει long polling στο κύριο SQS queue, λαμβάνοντας έως 10 μηνύματα κάθε φορά.
3. Για κάθε μήνυμα:
   - ελέγχει ότι το JSON και τα IDs είναι έγκυρα,
   - επιβεβαιώνει την έκδοση του contract, το event type και το επιτρεπτό `chainDepth`,
   - δηλώνει το event στο backend ως `RUNNING`,
   - ζητά από το backend το execution plan του workflow,
   - βρίσκει τις ενέργειες που αντιστοιχούν στο συγκεκριμένο activity και event,
   - εκτελεί τις ενέργειες σειριακά μέσω authenticated backend requests,
   - δηλώνει το event ως `SUCCEEDED` και αφαιρεί το μήνυμα από το queue.

## Υποστηριζόμενες ενέργειες

Ο worker δέχεται μόνο τις εξής προκαθορισμένες OpenAPI operations:

- pause / resume execution,
- terminate workflow execution,
- αλλαγή workflow flag,
- ανάθεση χρήστη σε activity,
- αφαίρεση χρήστη από activity.

Τα inputs πρέπει να είναι σταθερές τιμές ή αντικείμενα από σταθερές τιμές. Response branches και άλλοι τύποι operations απορρίπτονται.

## Ασφάλεια και αξιοπιστία

- Κάθε backend request υπογράφεται με βραχύβιο RSA JWT (`RS256`) που περιλαμβάνει το operation και τα IDs του event/workflow.
- Η idempotency βασίζεται στο `eventId` και στο index κάθε operation, ώστε επαναπαραδόσεις από το SQS να μην εφαρμόζουν ξανά 
ολοκληρωμένες ενέργειες.
- Αν το backend αναφέρει ότι ένα event έχει ήδη ολοκληρωθεί, ο worker δεν το εκτελεί ξανά.
- Σε προσωρινό σφάλμα το event σημειώνεται ως `RETRYING` και το μήνυμα παραμένει στο queue για νέα προσπάθεια.
- Σε μόνιμο σφάλμα ή όταν εξαντληθεί το όριο προσπαθειών, το event σημειώνεται ως `DEAD_LETTER`, το μήνυμα μεταφέρεται στο DLQ 
και αφαιρείται από το κύριο queue.

## Λειτουργία υπηρεσίας

Το `GET /health` επιστρέφει `200` όσο ο worker λειτουργεί και `503` όταν τερματίζεται. Στα `SIGINT` και `SIGTERM` σταματά να παίρνει 
νέα εργασία, κλείνει τον health server και απελευθερώνει τον SQS client. Τα logs γράφονται ως JSON στο standard output.

Το κύριο entry point είναι το `src/main.js`, ενώ η επεξεργασία μηνυμάτων βρίσκεται στο `src/worker.js`, η εκτέλεση του plan 
στο `src/executor.js` και η επικοινωνία με το backend στο `src/backendClient.js`.
