/** FAQ copy for zk-voting.org/faq (French). {brand} is the display name. */

export default {
  "faq": {
    "meta": {
      "title": "Questions · {brand}",
      "description": "Questions sur {brand} : bulletins privés, sondages et scrutins, auto-hébergement, et ce que ce projet ne fait pas. Il n'y a rien à déposer."
    },
    "navLabel": "Rubriques des questions",
    "menu": "Rubriques",
    "homeLink": "Accueil",
    "onThisPage": "Sur cette page",
    "pager": {
      "prev": "Précédent",
      "next": "Suivant"
    },
    "group": {
      "start": "Pour commencer",
      "faqs": "Questions fréquentes",
      "info": "Informations"
    },
    "links": {
      "resources": "Ressources",
      "home": "Accueil",
      "faq": "Ces questions",
      "poll": "Sondage et scrutin",
      "vision": "Perspective",
      "host": "Auto-héberger",
      "forum": "Forum communautaire",
      "demo": "Démo de vote",
      "github": "Code source",
      "email": "Courriel",
      "docs": "Guides du nœud"
    },
    "deploy": {
      "terminalLabel": "Démarrage rapide de l'auto-hébergement",
      "terminalComment": "# lancez votre propre nœud",
      "title": "Comment déployer",
      "nav": "Comment déployer",
      "lede": "Faites tourner le nœud vous-même. Ne déployez pas un pool, un pont ni une vente de jetons. Ces pièces ne sont pas dans ce logiciel.",
      "start": {
        "q": "Comment démarrer un nœud ?",
        "a": "À partir d'une copie de travail, copiez le fichier d'environnement d'exemple, puis démarrez la pile. Le nœud répond à un contrôle de santé. Ce site web n'est que l'explication. Ce n'est pas le nœud."
      },
      "platforms": {
        "q": "Quelles plateformes ?",
        "a": "Docker Compose, Coolify, Dokploy ou CapRover. Le nœud peut rester privé derrière un sidecar Tailscale."
      },
      "not": {
        "q": "Que ne dois-je pas déployer ?",
        "a": "Ne déployez pas un pool de prêt, un pont pour les dépôts ni une vente de jetons. Ce logiciel ne les contient pas. Épinglez les contrats du nœud de ce groupe, et ne traitez pas la démo comme une cérémonie achevée."
      }
    },
    "welcome": {
      "title": "Bienvenue",
      "nav": "Bienvenue",
      "lede": "Notes pour les votants, les responsables et les personnes qui décident d'héberger un nœud. Ceci n'est pas un protocole de prêt. Il n'y a rien à déposer.",
      "p1": "{brand} est un moyen ouvert et sans but lucratif pour qu'un groupe fasse tourner ses propres élections et sondages. Une élection civique, c'est une personne, une voix, et le choix est conçu pour ne pas être publié. Séparément, un hôte peut ouvrir un signal consultatif sur le réseau principal Ethereum. Ce signal n'est pas une élection civique : le poids vient d'un ERC-20 à un bloc finalisé, il n'y a pas d'inscription, signer est gratuit et le choix reste public.",
      "p2": "Ces pages suivent la page d'accueil. Elles expliquent en quoi un sondage diffère d'un scrutin, ce qui est public, ce qui est conçu pour rester privé, et comment un groupe héberge son propre nœud. Elles ne promettent pas qu'un déploiement satisfait une loi électorale.",
      "disclaimerTitle": "Avertissement",
      "disclaimer": "Ce site est une information générale. Ce n'est pas un conseil juridique et ce n'est pas une certification. {brand} est en développement actif. Les tests utilisent un vérificateur fictif, et la cérémonie de configuration de confiance n'a pas encore eu lieu. Ne l'utilisez pas aujourd'hui pour une élection contraignante. Adopter un scrutin n'exécute jamais rien tout seul."
    },
    "quick-links": {
      "title": "Liens rapides",
      "nav": "Liens rapides",
      "lede": "Les pages et les salles qui existent pour ce projet. Il n'y a pas d'écran d'emprunt, pas d'écran de prêt, et aucun endroit pour déposer des fonds.",
      "note": "Les marchés, les liquidations, les enchères de réserves, les programmes d'incitation et les paniers de prix ne font pas partie de {brand}. Si une page vous demande de déposer ou d'acheter un jeton, ce n'est pas ce projet."
    },
    "glossary": {
      "title": "Glossaire",
      "nav": "Glossaire",
      "lede": "Définitions courtes. Elles suivent la page d'accueil, et elles laissent de côté ce que ce projet ne fait pas.",
      "note": "Les définitions sont simplifiées et peuvent ne pas former une spécification complète.",
      "civic": {
        "term": "Élection civique",
        "def": "Une personne, une voix, avec inscription et scrutin secret."
      },
      "signal": {
        "term": "Signal par jeton",
        "def": "Un sondage consultatif pondéré par un ERC-20 à un bloc Ethereum finalisé. Il n'y a pas d'inscription, et le choix reste public. Il n'utilise pas la L2 civique."
      },
      "poll": {
        "term": "Sondage",
        "def": "Une consultation civique qui publie les décomptes par choix selon un calendrier horaire différé après un seuil. La participation utilise ce même calendrier horaire."
      },
      "vote": {
        "term": "Scrutin",
        "def": "Une consultation civique qui garde les choix scellés jusqu'à l'échéance. La participation est publiée selon un calendrier horaire différé. Il n'y a pas de totaux provisoires par choix."
      },
      "roll": {
        "term": "Liste",
        "def": "L'ensemble éligible d'une élection. Il stocke des engagements d'identité, pas des noms, des adresses de portefeuille ni des numéros de document."
      },
      "commitment": {
        "term": "Engagement d'identité",
        "def": "La valeur écrite sur la liste. Ce n'est pas une adresse de portefeuille et ce n'est pas un numéro de document."
      },
      "revote": {
        "term": "Revote",
        "def": "L'opérateur décide à la création si le revote est autorisé, et ce réglage ne peut plus être modifié par la suite. S'il est autorisé, le dernier bulletin avant l'échéance compte. Sinon, un second bulletin est refusé."
      },
      "gate": {
        "term": "Seuil",
        "def": "Pour un sondage, les décomptes restent masqués jusqu'à ce que 100 votants aient déposé leur premier bulletin ou que la fin prévue arrive, selon ce qui arrive en premier."
      },
      "block": {
        "term": "Bloc horaire",
        "def": "Une tranche publiée des décomptes par choix d'un sondage. Une heure de moins de 10 bulletins fusionne vers l'avant jusqu'à ce qu'un bloc en ait au moins 10. Un bloc publié est conçu pour rester tel qu'il a été publié."
      },
      "receipt": {
        "term": "Reçu",
        "def": "Preuve qu'un bulletin a été accepté. Ce sont des empreintes, conçues pour ne pas révéler votre vote."
      },
      "guardian": {
        "term": "Gardien",
        "def": "L'une des parties k-of-n qui peuvent déchiffrer un scrutin seulement en agrégat à l'échéance. La conception ne donne à l'opérateur aucune part de clé."
      },
      "l2": {
        "term": "L2 civique",
        "def": "Un séquenceur et un prouveur conçus pour cet usage, qu'un groupe fait tourner pour ses propres élections. Il règle des lots sur Ethereum. Ce n'est pas une chaîne généraliste."
      },
      "uuid": {
        "term": "UUID d'élection",
        "def": "L'identifiant public d'une élection, unique dans cette L2. Ethereum identifie un lot par le hash de l'ID de L2 et de cet UUID."
      },
      "mock": {
        "term": "Vérificateur fictif",
        "def": "Le remplaçant utilisé dans les tests à la place d'une vraie vérification de preuve. Avec lui, le refus d'un votant qui n'est pas préapprouvé n'est pas encore appliqué."
      }
    },
    "general": {
      "title": "Généralités",
      "nav": "Généralités",
      "lede": "Ce qu'est le projet, ce qu'il coûte, et ce qu'il refuse d'affirmer.",
      "what": {
        "q": "Qu'est-ce que {brand} ?",
        "a": "Un système de vote ouvert et sans but lucratif que tout groupe peut faire tourner lui-même. Les preuves à divulgation nulle de connaissance sont conçues pour montrer que seules des personnes éligibles ont voté, une fois chacune, et que le décompte publié correspond aux bulletins. Les tests utilisent pour l'instant un vérificateur fictif. Les choix individuels sont conçus pour ne pas être publiés."
      },
      "features": {
        "q": "Quelles sont les fonctions principales ?",
        "a": "L'auto-hébergement, et une personne, une voix dans une élection civique. Un signal consultatif séparé qui n'est pas un scrutin secret. Des sondages avec des décomptes par choix selon un horaire différé après un seuil, et des scrutins qui restent scellés jusqu'à l'échéance. Inscriptions publiques et codes de mise à l'écart. Des reçus qui sont des empreintes. Une licence AGPL, aucun frais pour les votants, et aucun jeton de produit."
      },
      "who": {
        "q": "À qui ça s'adresse ?",
        "a": "Tout organe qui a besoin d'une liste, d'un bulletin et d'un résultat que les gens peuvent vérifier : villes, comtés, syndicats, coopératives, conseils, écoles, clubs et observateurs."
      },
      "fees": {
        "q": "Quels sont les frais ?",
        "a": "Les votants ne sont pas facturés. Il n'y a pas de dépôt, pas de frais d'ouverture et pas d'intérêt. Un hôte paie ses propres serveurs. Sur la L2 civique, la clé Ethereum de l'opérateur, financée au minimum, paie l'envoi des lots. Pour un signal par jeton, signer un bulletin est gratuit. Déléguer ce jeton est la transaction qui coûte du gaz."
      },
      "audit": {
        "q": "A-t-il été audité ?",
        "a": "Pas en tant que système achevé. Le code est public sous AGPL-3.0-or-later. Les tests utilisent un vérificateur fictif, le premier chemin de preuve est en cours et la cérémonie de configuration de confiance n'a pas encore eu lieu. Il n'y a pas de programme payant de primes aux bogues."
      },
      "down": {
        "q": "Que se passe-t-il si ce site web tombe ?",
        "a": "Ce site web explique seulement le projet. L'élection d'un groupe tourne sur le nœud que ce groupe héberge. Le logiciel est ouvert, donc quelqu'un d'autre peut servir les mêmes pages depuis le dépôt. Un nœud peut aussi rester sur un réseau privé."
      },
      "admin": {
        "q": "Quelqu'un contrôle-t-il chaque élection ?",
        "a": "Non. Chaque groupe fait tourner son propre nœud et possède sa liste. Les responsables de ce nœud créent les élections, figent la liste, enregistrent les mises à l'écart et publient le décompte. Ces tâches ne sont pas une porte dérobée qui publie les choix."
      }
    },
    "elections": {
      "title": "Élections",
      "nav": "Élections",
      "lede": "Une consultation avec une liste et un bulletin. Pas un pool de liquidité.",
      "what": {
        "q": "Qu'est-ce qu'une élection ici ?",
        "a": "Une consultation avec une liste, un bulletin et un résultat publié. À la création, l'opérateur choisit un sondage ou un scrutin, et si le revote est autorisé. Ce réglage ne peut plus être modifié par la suite."
      },
      "many": {
        "q": "Un nœud peut-il faire tourner plusieurs élections ?",
        "a": "Oui. Une L2 civique peut contenir n'importe quel nombre d'élections. N'importe qui peut faire tourner une L2 civique, et il n'y a pas de limite au nombre qui existent."
      },
      "id": {
        "q": "Comment une élection est-elle identifiée ?",
        "a": "Par un UUID d'élection, unique dans cette L2. Les lots réglés sur Ethereum sont identifiés par le hash de l'ID de L2 et l'UUID de l'élection, donc deux groupes ne partagent pas un registre seulement en réutilisant un nom."
      },
      "districts": {
        "q": "Les circonscriptions peuvent-elles être imbriquées ?",
        "a": "Oui. Une ville, un comté ou une circonscription peut mener des élections et des référendums avec des circonscriptions imbriquées, des mesures et des articles. Cette structure vit sur la liste du groupe. Ce n'est pas une chaîne séparée."
      }
    },
    "registration": {
      "title": "Inscription",
      "nav": "Inscription",
      "lede": "Rejoindre une liste. Rien n'est déposé et rien n'est prêté.",
      "join": {
        "q": "Comment quelqu'un rejoint-il une élection civique ?",
        "a": "La personne s'inscrit avec une clé d'accès, un portefeuille, un courriel ou une pièce d'identité. La liste stocke un engagement d'identité. S'inscrire à une élection n'inscrit pas la personne à chaque consultation du nœud."
      },
      "stored": {
        "q": "Qu'est-ce qui est stocké sur la liste ?",
        "a": "Un engagement d'identité. Pas un nom, pas une adresse de portefeuille, et pas un numéro de document."
      },
      "deposit": {
        "q": "L'inscription est-elle un dépôt ?",
        "a": "Non. Rien de valeur n'est bloqué, mis sous séquestre ou prêté. Il n'y a ni collatéral ni panier de prix."
      },
      "token": {
        "q": "Un solde de jeton me met-il sur la liste ?",
        "a": "Pas pour une élection civique. Un signal par jeton est à part : détenir l'ERC-20 choisi à un bloc finalisé est le titre, il n'y a pas d'inscription et le choix reste public."
      }
    },
    "ballots": {
      "title": "Bulletins",
      "nav": "Bulletins",
      "lede": "Marquer un choix et prouver que vous aviez le droit de le marquer.",
      "cast": {
        "q": "Comment un bulletin est-il déposé ?",
        "a": "Le votant marque un choix et envoie une preuve conçue pour montrer qu'il figure sur la liste figée et n'est pas écarté. Les votants ne sont pas facturés pour cet envoi."
      },
      "change": {
        "q": "Puis-je changer mon vote ?",
        "a": "Seulement si l'opérateur a autorisé le revote à la création de l'élection. L'opérateur décide à la création si le revote est autorisé, et ce réglage ne peut plus être modifié par la suite. S'il est autorisé, le dernier bulletin avant l'échéance compte. Sinon, un second bulletin est refusé."
      },
      "proof": {
        "q": "Que montre la preuve ?",
        "a": "Qu'une personne éligible a voté, une fois, de la façon que cette élection permet, et que le bulletin est bien formé. Elle est conçue pour ne pas montrer quelle option a été marquée. Avec le vérificateur fictif dans les tests, cette vérification n'est pas encore appliquée."
      },
      "back": {
        "q": "Que reçois-je en retour ?",
        "a": "Un reçu d'empreintes, conçu pour ne pas révéler votre vote. Chaque bulletin, y compris un vote remplacé, en reçoit un."
      }
    },
    "polls": {
      "title": "Sondages",
      "nav": "Sondages",
      "lede": "Une consultation civique qui peut montrer des décomptes par choix en cours, avec un délai, après un seuil.",
      "what": {
        "q": "Qu'est-ce qu'un sondage ?",
        "a": "Une consultation civique qui publie les décomptes par choix selon un calendrier horaire différé après un seuil. La participation est publiée selon un calendrier horaire différé pour un sondage comme pour un scrutin."
      },
      "when": {
        "q": "Quand les décomptes par choix apparaissent-ils ?",
        "a": "Dès que 100 votants ont déposé leur premier bulletin, ou à l'arrivée de la fin prévue, selon ce qui arrive en premier. Chaque heure est publiée 30 minutes après sa clôture."
      },
      "small": {
        "q": "Et si une heure est petite ?",
        "a": "Une heure de moins de 10 bulletins fusionne vers l'avant jusqu'à ce qu'un bloc en ait au moins 10."
      },
      "blocks": {
        "q": "Les blocs horaires publiés changent-ils ?",
        "a": "Non. Les blocs horaires publiés sont conçus pour rester tels qu'ils ont été publiés. Si le revote était autorisé, les bulletins de remplacement n'apparaissent que dans le décompte final."
      }
    },
    "votes": {
      "title": "Scrutins",
      "nav": "Scrutins",
      "lede": "Une consultation civique dont les choix restent scellés jusqu'à l'échéance.",
      "what": {
        "q": "Qu'est-ce qu'un scrutin ?",
        "a": "Une consultation civique qui garde les choix scellés jusqu'à l'échéance. La participation est publiée selon un calendrier horaire différé. Il n'y a pas de totaux provisoires par choix."
      },
      "read": {
        "q": "Quand les choix peuvent-ils être lus ?",
        "a": "À l'échéance, et seulement en agrégat. Les choix sont chiffrés avec une clé publique publiée sur la L2. La clé privée correspondante est partagée entre les gardiens par le partage de secret de Shamir, conçu pour qu'aucune partie seule, pas même l'opérateur, ne puisse déchiffrer avant l'heure. La conception ne donne à l'opérateur aucune part de clé."
      },
      "why": {
        "q": "Pourquoi choisir un scrutin plutôt qu'un sondage ?",
        "a": "Quand un décompte par choix en cours ajouterait de la pression. Rien de ce que reçoit un votant n'est conçu pour prouver son choix à quelqu'un qui fait pression sur lui."
      },
      "rank": {
        "q": "Un scrutin peut-il être préférentiel ?",
        "a": "Oui, sur option. Le vote préférentiel est aussi disponible dans les sondages. Dans un scrutin scellé, les gardiens voient alors chaque classement, pas l'identité."
      }
    },
    "results": {
      "title": "Résultats",
      "nav": "Résultats",
      "lede": "Ce qui est visible pendant qu'une consultation est ouverte, et ce qui est publié après l'échéance.",
      "open": {
        "q": "Qu'est-ce qui est publié pendant qu'une consultation est ouverte ?",
        "a": "La participation est publiée selon un calendrier horaire différé pour les deux types. Un sondage publie aussi les décomptes par choix selon ce calendrier dès que 100 votants ont déposé leur premier bulletin, ou à l'arrivée de la fin prévue, selon ce qui arrive en premier. Un scrutin ne publie les choix qu'à l'échéance."
      },
      "deadline": {
        "q": "Que se passe-t-il à l'échéance ?",
        "a": "Plus aucun bulletin n'est accepté. Un lot final part vers Ethereum à l'échéance. Une fenêtre de contestation, qui doit durer plus de zéro, précède le décompte final."
      },
      "extra": {
        "q": "Qu'est-ce que le lot supplémentaire ?",
        "a": "Après le délai de grâce, n'importe qui peut publier un lot final manquant et le lot supplémentaire, avant le décompte final."
      },
      "execute": {
        "q": "Le décompte met-il la décision à exécution ?",
        "a": "Non. Adopter un scrutin n'exécute jamais rien tout seul. Les résultats sont vérifiables. Agir dessus reste aux personnes."
      },
      "check": {
        "q": "Comment une personne extérieure peut-elle vérifier ?",
        "a": "Chacun peut vérifier que les totaux publiés correspondent aux bulletins acceptés. Un auditeur indépendant est censé pouvoir reconstruire un résultat publié sans la base de données privée de l'opérateur. Tant qu'un vérificateur d'agrégat réel n'est pas en place, le décompte est contrôlé en additionnant les chiffrés sur la chaîne."
      }
    },
    "privacy": {
      "title": "Confidentialité",
      "nav": "Confidentialité",
      "lede": "Le choix est le secret. Le processus est la partie publique.",
      "private": {
        "q": "Qu'est-ce qui est conçu pour rester privé ?",
        "a": "L'option d'un bulletin civique. Elle est conçue pour ne jamais être un champ lisible dans une transaction ou une base de données. Les reçus sont des empreintes, conçues pour ne pas révéler votre vote."
      },
      "public": {
        "q": "Qu'est-ce qui est public ?",
        "a": "Les inscriptions et les codes de mise à l'écart sont publics. La participation est publiée selon un calendrier horaire différé pour les deux types. Un sondage publie aussi les décomptes par choix selon ce calendrier dès que 100 votants ont déposé leur premier bulletin, ou à l'arrivée de la fin prévue, selon ce qui arrive en premier. Le décompte final est public aussi."
      },
      "delay": {
        "q": "Pourquoi attendre pour publier la participation ?",
        "a": "Afin qu'une sortie d'un bureau de vote ne puisse pas être rapprochée d'un signal en direct. Le délai, c'est le calendrier horaire. Les décomptes ne sont pas complétés par du remplissage."
      },
      "signal": {
        "q": "Un signal par jeton est-il privé ?",
        "a": "Non. Dans un signal par jeton, le choix reste public. Le scrutin secret est l'élection civique."
      }
    },
    "officers": {
      "title": "Responsables",
      "nav": "Responsables",
      "lede": "Le groupe qui héberge le nœud possède la liste. Les responsables ont des tâches, pas une clé maîtresse.",
      "who": {
        "q": "Qui fait tourner un nœud ?",
        "a": "Le groupe qui l'héberge. Il possède le nœud, la liste et le registre. Aucun compte fournisseur n'est requis pour commencer, et il n'y a pas d'enfermement fournisseur."
      },
      "jobs": {
        "q": "Que font les responsables ?",
        "a": "Ils créent l'élection et le bulletin, figent la liste, approuvent l'inscription, enregistrent une mise à l'écart avec un code de motif public et publient le décompte après l'échéance. Un hôte peut aussi publier ses propres pages."
      },
      "read": {
        "q": "Un responsable peut-il lire comment les gens ont voté ?",
        "a": "Ce n'est pas la conception. Les choix d'un scrutin sont chiffrés avec la clé des gardiens, et l'opérateur n'a aucune part de clé. Un sondage publie des agrégats. Les responsables n'ont pas de flux privé en direct des choix."
      }
    },
    "dq": {
      "title": "Mise à l'écart",
      "nav": "Mise à l'écart",
      "lede": "Écarter quelqu'un est un changement public et codé. Ce n'est pas un drapeau silencieux.",
      "why": {
        "q": "Pourquoi une personne inscrite peut-elle être écartée ?",
        "a": "Inscrit n'est pas la même chose qu'éligible. Un responsable peut écarter quelqu'un avec un code de motif énoncé, par exemple n'ayant pas l'âge, n'étant pas résident, un doublon ou une décision de justice. Le code est public pour qu'une purge ne puisse pas se cacher."
      },
      "evidence": {
        "q": "Où vont les éléments ?",
        "a": "Les éléments personnels restent hors chaîne. Le registre public est le code de motif et une empreinte des éléments, afin qu'un examen ultérieur puisse rattacher un dossier scellé à ce qui a été publié."
      },
      "barred": {
        "q": "Une personne écartée peut-elle voter quand même ?",
        "a": "Non. L'ensemble éligible, ce sont les personnes inscrites et non écartées en ce moment. La preuve est conçue pour exiger l'appartenance à cet ensemble. Avec le vérificateur fictif dans les tests, cette vérification n'est pas encore appliquée."
      }
    },
    "receipts": {
      "title": "Reçus",
      "nav": "Reçus",
      "lede": "Preuve que vous avez voté. Pas la preuve de l'option que vous avez marquée.",
      "what": {
        "q": "Qu'y a-t-il sur un reçu ?",
        "a": "Des empreintes qui montrent qu'un bulletin a été accepté. Assez pour le retrouver, pas l'option qui a été marquée. Si un écran indique l'option choisie, c'est un bogue."
      },
      "check": {
        "q": "Comment vérifier qu'il a été compté ?",
        "a": "Sur le nœud qui a fait tourner l'élection, ouvrez la page du reçu et collez la preuve, ou utilisez le fichier que le nœud vous a donné. La vérification répond si ce bulletin a été accepté. Elle ne montre pas de candidat."
      },
      "pressure": {
        "q": "Quelqu'un peut-il exiger mon reçu comme preuve de mon choix ?",
        "a": "Un reçu est conçu pour ne pas révéler votre vote. Il ne peut pas satisfaire quelqu'un qui exige une preuve du choix. Ce refus est voulu."
      }
    },
    "token": {
      "title": "Pas un jeton",
      "nav": "Pas un jeton",
      "lede": "Il n'y a pas de jeton du projet, pas de récompense pour voter, et rien à déposer.",
      "product": {
        "q": "Y a-t-il un jeton {brand} ?",
        "a": "Non. Il n'y a pas de jeton de produit, pas de palier payant et pas de récompense pour avoir voté. La licence est AGPL-3.0-or-later. Le dépôt n'est pas un moyen de gagner de l'argent."
      },
      "signal": {
        "q": "Alors, qu'est-ce qu'un signal par jeton ?",
        "a": "Un mode consultatif facultatif sur le réseau principal Ethereum. L'hôte choisit un ERC-20 déjà existant. Le poids vient de ce jeton à un bloc finalisé. Le pouvoir de vote délégué y est lu. Ce n'est pas un scrutin secret, il n'utilise pas la liste civique, et le résultat n'exécute rien."
      },
      "markets": {
        "q": "Y a-t-il des programmes d'incitation ou des pools de liquidité ?",
        "a": "Non. Il n'y a rien à déposer, prêter, emprunter, liquider ou mettre aux enchères. N'envoyez pas de fonds à quiconque annonce une vente de jetons sous ce nom."
      }
    },
    "community": {
      "title": "Communauté",
      "nav": "Communauté",
      "lede": "Un forum et un dépôt public. Pas un cycle de subventions.",
      "talk": {
        "q": "Où les gens discutent-ils ?",
        "a": "Sur le forum communautaire. Les groupes discutent d'usages réels, de faire tourner un nœud et de la suite à construire."
      },
      "grants": {
        "q": "Y a-t-il un programme de subventions ?",
        "a": "Pas de subventions en jetons et pas de scrutin de financement. La contribution est celle, ordinaire, du logiciel ouvert : lire le code, ouvrir un signalement ou envoyer un correctif."
      },
      "help": {
        "q": "Pouvez-vous aider un groupe à se lancer ?",
        "a": "Oui. Le projet peut être mandaté pour une mise en place locale. Utilisez l'adresse de courriel du pied de page."
      }
    },
    "runs": {
      "title": "Où cela tourne",
      "nav": "Où cela tourne",
      "lede": "Les bulletins civiques se règlent sur Ethereum. Il n'y a pas de pont entre marchés de prêt, parce qu'il n'y a pas de marchés de prêt.",
      "land": {
        "q": "Où aboutissent les bulletins civiques ?",
        "a": "Sur la L2 civique du groupe, un séquenceur et un prouveur conçus pour cet usage. Les lots finaux se règlent sur Ethereum afin que le registre survive à n'importe quel opérateur. L'activité courante n'est pas une chaîne généraliste, et elle ne fait pas passer de dépôts par un pont."
      },
      "signal": {
        "q": "Où aboutissent les signaux par jeton ?",
        "a": "Sur le réseau principal Ethereum seulement. Ce mode a besoin d'un RPC du réseau principal Ethereum. Il n'utilise pas la L2 civique."
      },
      "addresses": {
        "q": "Y a-t-il une seule liste d'adresses officielles de contrats ?",
        "a": "Aucun déploiement global unique n'est publié ici sous forme de tableau à copier. Chaque groupe épingle les contrats que son propre nœud utilise. Le nœud de démo sert à essayer le logiciel, pas à une élection de production."
      },
      "rebuild": {
        "q": "Les résultats peuvent-ils être reconstruits si un nœud disparaît ?",
        "a": "Régler sur Ethereum est ce qui rend cela possible. Les résultats sont conçus pour être reconstruits à partir des données de la L2 ou du registre L1. Une racine non prouvée ne publie rien et peut revenir en arrière après un délai."
      }
    },
    "fits": {
      "title": "Comment cela s'assemble",
      "nav": "Comment cela s'assemble",
      "lede": "De nombreuses L2 civiques indépendantes. Un registre partagé sur Ethereum.",
      "picture": {
        "q": "Quelle est la vue d'ensemble ?",
        "a": "N'importe qui peut faire tourner une L2 civique, et il n'y a pas de limite au nombre qui existent. Chaque L2 peut contenir n'importe quel nombre d'élections. Chaque L2 règle ses lots de votes sur Ethereum, identifiés par le hash de l'ID de L2 et l'UUID de l'élection."
      },
      "inside": {
        "q": "Que se passe-t-il dans une L2 ?",
        "a": "Les votants à la périphérie votent gratuitement. Seules les personnes préapprouvées sont acceptées. Le séquenceur regroupe les votes. La L2 calcule la racine d'état et le décompte. L1 consigne cette racine chaque heure et est conçue pour vérifier une preuve du calcul ensuite, dans l'ordre. Tant qu'un vérificateur d'agrégat réel n'est pas en place, le décompte est contrôlé en additionnant les chiffrés sur la chaîne."
      },
      "drawing": {
        "q": "Où est le schéma ?",
        "a": "La page d'accueil le dessine : une vue macro de nombreuses L2, une vue L2 d'une équipe électorale, et le parcours qu'un sondage et un scrutin suivent jusqu'au décompte final. Ces figures sont le schéma du protocole."
      }
    },
    "roadmap": {
      "title": "Feuille de route",
      "nav": "Feuille de route",
      "lede": "Ce qui est vrai sur cette ligne de développement, et ce qu'un décompte ne se mettra pas à faire plus tard.",
      "today": {
        "q": "Qu'est-ce qui est vrai aujourd'hui ?",
        "a": "Vous pouvez lire ce site et essayer la démo de vote. Les tests utilisent un vérificateur fictif. La cérémonie de configuration de confiance n'a pas encore eu lieu. Ne l'utilisez pas aujourd'hui pour une élection contraignante."
      },
      "proving": {
        "q": "Quel est le chemin de preuve ?",
        "a": "Une vraie vérification de preuve est en cours. Avec le vérificateur fictif dans les tests, le refus d'un votant qui n'est pas préapprouvé n'est pas encore appliqué. Ne décrivez pas une démo locale comme prête pour une élection contraignante."
      },
      "never": {
        "q": "Que ne fera pas un résultat ?",
        "a": "Il ne s'exécutera pas tout seul. Le décompte est une preuve. Agir dessus reste aux personnes. Le projet n'ajoutera pas non plus un jeton de produit ni des frais pour les votants."
      }
    },
    "builder": {
      "title": "Kit pour bâtir",
      "nav": "Kit pour bâtir",
      "lede": "Le dépôt est le kit de départ. Faites-en un fork, et gardez la mention sans but lucratif.",
      "repo": {
        "q": "Qu'y a-t-il dans le dépôt ?",
        "a": "Le nœud, la L2 civique, les contrats et les circuits, ensemble, sous AGPL-3.0-or-later. Un groupe n'est pas censé dépendre d'une compilation privée d'un fournisseur. Faites-en un fork et gardez la mention sans but lucratif."
      },
      "read": {
        "q": "Que dois-je lire d'abord ?",
        "a": "Le README à la racine du dépôt, puis les guides d'auto-hébergement. Chaque nœud en marche sert ces guides sur /docs."
      },
      "agpl": {
        "q": "Que demande l'AGPL à un hôte ?",
        "a": "Si vous faites tourner un nœud modifié comme service réseau, offrez le code source correspondant aux personnes qui utilisent ce service."
      }
    }
  }
};
