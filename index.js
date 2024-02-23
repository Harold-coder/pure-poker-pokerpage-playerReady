const AWS = require('aws-sdk');
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const gameTableName = process.env.GAME_TABLE;
const Deck = require('./Deck');
const connectionsTableName = process.env.CONNECTIONS_TABLE; // Table for WebSocket connections
const apiGatewayManagementApi = new AWS.ApiGatewayManagementApi({
    endpoint: process.env.WEBSOCKET_ENDPOINT // Set this environment variable to your WebSocket API endpoint.
});

function setBlindsAndDeal(gameState) {
    const smallBlindAmount = gameState.initialBigBlind / 2;
    const bigBlindAmount = gameState.initialBigBlind;
    const bigBlindIndex = (gameState.smallBlindIndex + 1) % gameState.players.length;

    const deck = new Deck();
    deck.shuffle();

    const updatedPlayers = gameState.players.map((player, index) => {
        const isSmallBlind = index === gameState.smallBlindIndex;
        const isBigBlind = index === bigBlindIndex;
        const betAmount = isSmallBlind ? smallBlindAmount : (isBigBlind ? bigBlindAmount : 0);
        const chips = player.chips - betAmount;
        const potContribution = player.potContribution + betAmount;
        
        return {
            ...player,
            bet: betAmount,
            chips,
            potContribution,
            hand: deck.deal(2),
        };
    });

    const newPot = gameState.pot + smallBlindAmount + bigBlindAmount;
    const nextTurn = (bigBlindIndex + 1) % gameState.players.length;
    const newGameState = {
        ...gameState,
        players: updatedPlayers,
        pot: newPot,
        deck: deck,
        gameStage: 'preFlop',
        highestBet: 10,
        bettingStarted: true,
        currentTurn: nextTurn,
    };

    return newGameState;
}


exports.handler = async (event) => {
    const connectionId = event.requestContext.connectionId;
    const { gameId, playerId } = JSON.parse(event.body);

    try {
        const game = await getGameState(gameId);

        if (!game || game.gameStage !== 'gameOver') {
            throw new Error("Game not found or not in 'gameOver' stage.");
        }

        // Set player.ready to true
        const playerIndex = game.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1) {
            throw new Error("Player not found.");
        }
        game.players[playerIndex].isReady = true;

        // Check if all players are ready or 30 seconds have passed
        const allReady = game.players.every(p => p.chips >= game.initialBigBlind ? p.isReady : true); // Only check readiness for players with chips
        const timeElapsed = new Date() - new Date(game.gameOverTimeStamp); // assuming gameOverTimestamp is stored when game stage becomes 'gameOver'

        if (allReady || timeElapsed > 30000) {
            // Reset game state for a new game
            resetGameState(game);
            updatedGame = setBlindsAndDeal(game);
            await saveGameState(gameId, updatedGame);

            // Notify all players about the updated game state
            await notifyAllPlayers(gameId, updatedGame);
        }

        return { statusCode: 200, body: 'Player ready processed.' };
    } catch (error) {
        console.error('Error processing playerReady:', error);
        // Optionally, send an error message back to the caller
        await apiGatewayManagementApi.postToConnection({
            ConnectionId: connectionId,
            Data: JSON.stringify({ error: error.message })
        }).promise();

        return { statusCode: 500, body: JSON.stringify({ message: error.message }) };
    }
};

async function getGameState(gameId) {
    const params = {
        TableName: gameTableName,
        Key: { gameId },
    };
    const { Item } = await dynamoDb.get(params).promise();
    return Item;
}

async function saveGameState(gameId, game) {
    const params = {
        TableName: gameTableName,
        Key: { gameId },
        UpdateExpression: "SET players = :p, playerCount = :pc, smallBlindIndex = :sb, gameOverTimeStamp = :gOTS, bettingStarted = :bS, minRaiseAmount = :mRA, deck = :deck, pot = :pot, gameStage = :gs, currentTurn = :ct, communityCards = :cc, highestBet = :hb, gameInProgress = :gip, netWinners = :nw",
        ExpressionAttributeValues: {
            ":p": game.players,
            ":pc": game.playerCount,
            ":sb": game.smallBlindIndex,
            ":gOTS": game.gameOverTimeStamp,
            ":bS": game.bettingStarted,
            ":mRA": game.minRaiseAmount,
            ":pot": game.pot,
            ":gs": game.gameStage,
            ":ct": game.currentTurn,
            ":cc": game.communityCards,
            ":hb": game.highestBet,
            ":gip": game.gameInProgress,
            ":nw": game.netWinners,
            ":deck": game.deck
        },
        ReturnValues: "UPDATED_NEW"
    };
    await dynamoDb.update(params).promise();
}

async function notifyAllPlayers(gameId, game) {
    // Retrieve all connection IDs for this game from the connections table
    const connectionData = await dynamoDb.scan({ TableName: connectionsTableName, FilterExpression: "gameId = :gameId", ExpressionAttributeValues: { ":gameId": gameId } }).promise();
    const postCalls = connectionData.Items.map(async ({ connectionId }) => {
        await apiGatewayManagementApi.postToConnection({ 
            ConnectionId: connectionId,
             Data: JSON.stringify({
                game: game,
                action: "playerReady",
                statusCode: 200
            }) 
        }).promise();
    });
    await Promise.all(postCalls); // hello
}

async function resetGameState(game) {
    if (!game) {
        throw new Error("Game not found");
    }

    // Filter players who are ready and have enough chips
    const remainingPlayers = game.players.filter(player => player.chips >= game.initialBigBlind);
    const newPlayerCount = remainingPlayers.length;

    if (newPlayerCount >= game.minPlayers) {
        // Update small blind index
        game.smallBlindIndex = (game.smallBlindIndex + 1) % newPlayerCount;
        
        // Update player states for the new game
        game.players = remainingPlayers.map((player, index) => ({
            ...player,
            bet: 0,
            position: index,
            isAllIn: false,
            hasActed: false,
            inHand: true,
            amountWon: 0,
            handDescription: null,
            ready: false, // Reset readiness for the new game
            potContribution: 0,
        }));

        // Reset the game state
        game.pot = 0;
        game.communityCards = [];
        game.currentTurn = game.smallBlindIndex;
        game.gameStage = 'preDealing';
        game.highestBet = 0;
        game.netWinners = [];
        game.gameInProgress = true;
        game.gameOverTimeStamp = null;
        game.minRaiseAmount = game.initialBigBlind;
        game.bettingStarted = false;
        game.playerCount = newPlayerCount;

    } else {
        console.log("Not enough players to start a new game.");
    }
}