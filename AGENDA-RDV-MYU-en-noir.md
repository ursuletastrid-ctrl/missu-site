# RDV MYU en noir dans Google Agenda (futurs rendez-vous)

Les 3 RDV déjà dans ton agenda sont déjà en noir. Pour que les prochains le soient aussi, il faut changer UNE valeur dans ton Apps Script.

## Étapes (2 minutes)
1. Ouvre ton projet Apps Script MYU (script.google.com > ton projet agenda MYU).
2. Fais Ctrl+F (ou Cmd+F) et cherche : `color`
3. Tu vas trouver une ligne avec une couleur « 4 » (rose). Selon ton script, elle ressemble à l'une de ces deux :
   - `colorId: "4"`  → remplace par  `colorId: "8"`
   - `event.setColor("4")`  → remplace par  `event.setColor("8")`
4. Clique sur l'icône disquette (Enregistrer).
5. Déployer > Gérer les déploiements > crayon (Modifier) > Version : « Nouvelle version » > Déployer.
   (Sans cette étape, le site continue d'utiliser l'ancienne version.)

8 = Graphite, le noir le plus foncé que Google Agenda propose.
Si tu ne trouves pas la ligne, copie-moi le script et je te renvoie la ligne exacte.
